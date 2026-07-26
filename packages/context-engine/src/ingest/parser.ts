import type { EvidenceAnchor, StructuralFact, StructuralFactKind } from "../domain/evidence.js";
import { stableId } from "../domain/fingerprint.js";

export interface ParsedSymbol {
  name: string;
  kind: "class" | "function" | "interface" | "type" | "variable";
  startLine: number;
  endLine: number;
}

export interface ParsedImport {
  specifier: string;
  importedNames: string[];
  line: number;
}

export interface SourceAnalysis {
  language: string;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  facts: StructuralFact[];
}

export interface SourceParser {
  readonly name: string;
  readonly version: string;
  supports(path: string, language?: string): boolean;
  analyze(input: {
    tenantId: string;
    repository: string;
    ref: string;
    commitSha: string;
    path: string;
    blobSha: string;
    contentDigest: string;
    body: string;
    language?: string;
  }): SourceAnalysis;
}

const extensionLanguages: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java"
};

function languageFor(path: string, declared?: string): string {
  if (declared !== undefined && declared.trim() !== "") return declared.toLowerCase();
  const extension = Object.keys(extensionLanguages).find((value) => path.toLowerCase().endsWith(value));
  return extension === undefined ? "text" : extensionLanguages[extension]!;
}

function anchorFor(
  input: Parameters<SourceParser["analyze"]>[0],
  startLine: number,
  endLine = startLine
): EvidenceAnchor {
  return {
    tenantId: input.tenantId,
    repository: input.repository,
    sourceType: "blob",
    sourceId: input.blobSha,
    contentDigest: input.contentDigest,
    commitSha: input.commitSha,
    pathOrUrl: input.path,
    startLine,
    endLine
  };
}

function fact(
  input: Parameters<SourceParser["analyze"]>[0],
  parser: Pick<SourceParser, "name" | "version">,
  kind: StructuralFactKind,
  from: string,
  to: string,
  line: number,
  metadata: Record<string, unknown> = {}
): StructuralFact {
  const anchors = [anchorFor(input, line)];
  return {
    id: stableId("sf", { kind, from, to, anchors, parser: parser.version }),
    tenantId: input.tenantId,
    repository: input.repository,
    ref: input.ref,
    commitSha: input.commitSha,
    kind,
    from,
    to,
    anchors,
    derivationName: parser.name,
    derivationVersion: parser.version,
    metadata
  };
}

export class DeterministicSourceParser implements SourceParser {
  readonly name = "deterministic-source-parser";
  readonly version: string;

  constructor(version = "1") {
    this.version = version;
  }

  supports(path: string, language?: string): boolean {
    return languageFor(path, language) !== "text";
  }

  analyze(input: Parameters<SourceParser["analyze"]>[0]): SourceAnalysis {
    const language = languageFor(input.path, input.language);
    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const facts: StructuralFact[] = [];
    const lines = input.body.split(/\r?\n/);
    const symbolPatterns =
      language === "python"
        ? [
            { kind: "class" as const, expression: /^\s*class\s+([A-Za-z_]\w*)/ },
            { kind: "function" as const, expression: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ }
          ]
        : [
            { kind: "class" as const, expression: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
            { kind: "interface" as const, expression: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
            { kind: "type" as const, expression: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
            {
              kind: "function" as const,
              expression: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/
            },
            {
              kind: "variable" as const,
              expression: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/
            }
          ];
    for (const [offset, line] of lines.entries()) {
      const lineNumber = offset + 1;
      for (const pattern of symbolPatterns) {
        const match = pattern.expression.exec(line);
        if (match?.[1] !== undefined) {
          const symbol = { name: match[1], kind: pattern.kind, startLine: lineNumber, endLine: lineNumber };
          symbols.push(symbol);
          facts.push(fact(input, this, "defines", input.path, `${input.path}#${symbol.name}`, lineNumber, { symbol }));
          break;
        }
      }
      const jsImport = /^\s*import\s+(?:(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))(?:\s+from\s+)?|)["']([^"']+)["']/.exec(line);
      const pythonImport = /^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)|import\s+([A-Za-z0-9_.]+))/.exec(line);
      if (jsImport?.[3] !== undefined) {
        const importedNames = (jsImport[1] ?? jsImport[2] ?? "")
          .split(",")
          .map((value) => value.trim().split(/\s+as\s+/)[0] ?? "")
          .filter(Boolean);
        imports.push({ specifier: jsImport[3], importedNames, line: lineNumber });
        facts.push(fact(input, this, "imports", input.path, jsImport[3], lineNumber, { importedNames }));
      } else if (pythonImport !== null) {
        const specifier = pythonImport[1] ?? pythonImport[3]!;
        const importedNames = (pythonImport[2] ?? "")
          .split(",")
          .map((value) => value.trim().split(/\s+as\s+/)[0] ?? "")
          .filter(Boolean);
        imports.push({ specifier, importedNames, line: lineNumber });
        facts.push(fact(input, this, "imports", input.path, specifier, lineNumber, { importedNames }));
      }
    }
    return { language, symbols, imports, facts };
  }
}
