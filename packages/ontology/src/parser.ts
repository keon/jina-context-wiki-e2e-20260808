import { ONTOLOGY_PARSER_VERSION, type BlobAnalysis } from "./pipeline.js";

/** Pure, versioned structural parser. Provider I/O stays in the worker adapter. */
export function analyzeSourceBlob(blobSha: string, language: string, source: string): BlobAnalysis {
  const symbols: BlobAnalysis["symbols"][number][] = [];
  const imports: BlobAnalysis["imports"][number][] = [];
  const seenSymbols = new Set<string>();
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const declaration = /\b(?:export\s+)?(?:async\s+)?(class|function|interface|type|enum|const|let|var|def|struct|trait)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (declaration?.[1] && declaration[2] && !seenSymbols.has(declaration[2])) {
      seenSymbols.add(declaration[2]);
      symbols.push({ moniker: declaration[2], name: declaration[2], kind: declaration[1], startLine: lineNumber, endLine: lineNumber });
    }
    const importMatch = /(?:\bfrom\s+|\bimport\s*(?:[^"']*?\s+from\s+)?|\brequire\s*\()\s*["']([^"']+)["']/.exec(line);
    if (importMatch?.[1]) imports.push({ specifier: importMatch[1], line: lineNumber });
  });
  return {
    blobSha,
    parserVersion: ONTOLOGY_PARSER_VERSION,
    language,
    symbols: symbols.slice(0, 200),
    imports: imports.slice(0, 200)
  };
}

export function languageForPath(path: string): string | undefined {
  const extension = path.toLowerCase().split(".").at(-1);
  return ({
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    py: "python", go: "go", rs: "rust", java: "java", rb: "ruby", php: "php", cs: "csharp", cpp: "cpp", c: "c",
    h: "c", hpp: "cpp", swift: "swift", kt: "kotlin", md: "markdown", mdx: "markdown"
  } as Record<string, string>)[extension ?? ""];
}
