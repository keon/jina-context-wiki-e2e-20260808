import { createHash } from "node:crypto";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { ONTOLOGY_PARSER_VERSION, type BlobAnalysis, type CodeSymbolEdgeFact, type CodeSymbolFact } from "./pipeline.js";

const DECLARATION_KINDS: Readonly<Record<string, string>> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  method_definition: "method",
  variable_declarator: "variable"
};

/** Pure, versioned structural parser. Provider I/O stays in the worker adapter. */
export function analyzeSourceBlob(blobSha: string, language: string, source: string): BlobAnalysis {
  const astLanguage = treeSitterLanguage(language);
  if (!astLanguage) return lexicalFallback(blobSha, language, source);
  const symbols: CodeSymbolFact[] = [];
  const imports: BlobAnalysis["imports"][number][] = [];
  const edges: CodeSymbolEdgeFact[] = [];
  const seenSymbols = new Set<string>();
  const root = parse(astLanguage, source).root();

  walk(root, (node) => {
    const declarationKind = DECLARATION_KINDS[node.kind()];
    if (declarationKind) {
      const nameNode = field(node, "name") ?? firstNamedLeaf(node, new Set(["identifier", "property_identifier", "type_identifier"]));
      const name = nameNode?.text().trim();
      if (name) {
        const owner = enclosingDeclarationNames(node).reverse().join(".");
        const signature = normalizedSignature(node.text(), name);
        const signatureHash = hash(signature);
        const moniker = `${language}:${owner ? `${owner}.` : ""}${name}#${signatureHash.slice(0, 12)}`;
        if (!seenSymbols.has(moniker)) {
          seenSymbols.add(moniker);
          const range = node.range();
          symbols.push({
            moniker,
            name,
            kind: declarationKind,
            signatureHash,
            startLine: range.start.line + 1,
            endLine: Math.max(range.start.line + 1, range.end.line + 1)
          });
        }
      }
    }

    if (node.kind() === "import_statement") {
      const sourceNode = field(node, "source") ?? firstNamedLeaf(node, new Set(["string", "string_fragment"]));
      const specifier = stripQuotes(sourceNode?.text() ?? "");
      if (specifier) imports.push({ specifier, line: node.range().start.line + 1 });
    }

    if (node.kind() === "call_expression") {
      const target = field(node, "function")?.text().trim();
      pushEdge(edges, node, "calls", target);
    }
    if (node.kind() === "extends_clause" || node.kind() === "class_heritage") {
      const target = node.children().map((child) => child.text()).find((text) => !/^extends$/.test(text.trim()));
      pushEdge(edges, node, "extends", target);
    }
    if (node.kind() === "identifier" || node.kind() === "type_identifier") {
      const parentKind = node.parent()?.kind();
      if (!parentKind || DECLARATION_KINDS[parentKind] || parentKind === "call_expression" || parentKind === "import_clause") return;
      pushEdge(edges, node, "references", node.text());
    }
  });

  for (const item of imports) {
    edges.push({
      fromMoniker: moduleMoniker(language), kind: "imports", toMoniker: `module:${item.specifier}`,
      startLine: item.line, endLine: item.line
    });
  }
  return {
    blobSha,
    parserVersion: ONTOLOGY_PARSER_VERSION,
    language,
    symbols: dedupe(symbols, (symbol) => symbol.moniker).slice(0, 2_000),
    imports: dedupe(imports, (item) => `${item.specifier}:${item.line}`).slice(0, 2_000),
    edges: dedupe(edges, (edge) => `${edge.fromMoniker}:${edge.kind}:${edge.toMoniker}:${edge.startLine}:${edge.endLine}`).slice(0, 10_000)
  };
}

function pushEdge(edges: CodeSymbolEdgeFact[], node: SgNode, kind: CodeSymbolEdgeFact["kind"], target: string | undefined): void {
  const toMoniker = target?.replace(/\s+/g, " ").trim();
  if (!toMoniker || toMoniker.length > 300) return;
  const range = node.range();
  edges.push({
    fromMoniker: enclosingSymbolMoniker(node),
    kind,
    toMoniker,
    startLine: range.start.line + 1,
    endLine: Math.max(range.start.line + 1, range.end.line + 1)
  });
}

function enclosingSymbolMoniker(node: SgNode): string {
  for (const ancestor of node.ancestors()) {
    if (!DECLARATION_KINDS[ancestor.kind()]) continue;
    const name = field(ancestor, "name")?.text().trim();
    if (name) return name;
  }
  return "<module>";
}

function enclosingDeclarationNames(node: SgNode): string[] {
  return node.ancestors().flatMap((ancestor) => {
    if (!DECLARATION_KINDS[ancestor.kind()]) return [];
    const name = field(ancestor, "name")?.text().trim();
    return name ? [name] : [];
  });
}

function field(node: SgNode, name: string): SgNode | null {
  return (node as unknown as { field(value: string): SgNode | null }).field(name);
}

function firstNamedLeaf(node: SgNode, kinds: ReadonlySet<string>): SgNode | undefined {
  const queue = [...node.children()];
  while (queue.length > 0) {
    const child = queue.shift()!;
    if (kinds.has(String(child.kind()))) return child;
    queue.unshift(...child.children());
  }
  return undefined;
}

function walk(node: SgNode, visit: (node: SgNode) => void): void {
  visit(node);
  for (const child of node.children()) walk(child, visit);
}

function normalizedSignature(text: string, name: string): string {
  const header = text.split(/[\n{=]/, 1)[0] ?? text;
  return header.replace(name, "<name>").replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function treeSitterLanguage(language: string): Lang | undefined {
  if (language === "typescript") return Lang.TypeScript;
  if (language === "javascript") return Lang.JavaScript;
  return undefined;
}

function lexicalFallback(blobSha: string, language: string, source: string): BlobAnalysis {
  const symbols: CodeSymbolFact[] = [];
  const imports: BlobAnalysis["imports"][number][] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const declaration = /\b(?:export\s+)?(?:async\s+)?(class|function|interface|type|enum|const|let|var|def|struct|trait)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (declaration?.[1] && declaration[2]) {
      const signatureHash = hash(normalizedSignature(line, declaration[2]));
      symbols.push({
        moniker: `${language}:${declaration[2]}#${signatureHash.slice(0, 12)}`,
        name: declaration[2], kind: declaration[1], signatureHash, startLine: lineNumber, endLine: lineNumber
      });
    }
    const importMatch = /(?:\bfrom\s+|\bimport\s*(?:[^"']*?\s+from\s+)?|\brequire\s*\()\s*["']([^"']+)["']/.exec(line);
    if (importMatch?.[1]) imports.push({ specifier: importMatch[1], line: lineNumber });
  });
  return {
    blobSha, parserVersion: ONTOLOGY_PARSER_VERSION, language,
    symbols: dedupe(symbols, (symbol) => symbol.moniker).slice(0, 2_000),
    imports: dedupe(imports, (item) => `${item.specifier}:${item.line}`).slice(0, 2_000),
    edges: imports.map((item) => ({
      fromMoniker: moduleMoniker(language), kind: "imports" as const, toMoniker: `module:${item.specifier}`,
      startLine: item.line, endLine: item.line
    }))
  };
}

function moduleMoniker(language: string): string { return `${language}:<module>`; }
function stripQuotes(value: string): string { return value.replace(/^["'`]|["'`]$/g, "").trim(); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function dedupe<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => seen.has(key(value)) ? false : (seen.add(key(value)), true));
}

export function languageForPath(path: string): string | undefined {
  const extension = path.toLowerCase().split(".").at(-1);
  return ({
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    py: "python", go: "go", rs: "rust", java: "java", rb: "ruby", php: "php", cs: "csharp", cpp: "cpp", c: "c",
    h: "c", hpp: "cpp", swift: "swift", kt: "kotlin", md: "markdown", mdx: "markdown"
  } as Record<string, string>)[extension ?? ""];
}
