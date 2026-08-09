export interface MermaidFence {
  readonly start: number;
  readonly end: number;
  readonly markdown: string;
  readonly source: string;
}

/**
 * Scans CommonMark fenced code blocks whose info string starts with
 * `mermaid`. Both backtick and tilde fences are supported because the
 * dashboard's ReactMarkdown renderer treats both forms identically.
 */
export function mermaidFences(markdown: string): readonly MermaidFence[] {
  const fences: MermaidFence[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === "code" && node.lang?.toLowerCase() === "mermaid") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined && start <= end) {
        fences.push({ start, end, markdown: markdown.slice(start, end), source: node.value ?? "" });
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(fromMarkdown(markdown) as MarkdownNode);
  return fences.sort((left, right) => left.start - right.start);
}

export function replaceMermaidFences(markdown: string, replace: (fence: MermaidFence) => string): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const fence of mermaidFences(markdown)) {
    chunks.push(markdown.slice(cursor, fence.start), replace(fence));
    cursor = fence.end;
  }
  chunks.push(markdown.slice(cursor));
  return chunks.join("");
}

export async function replaceMermaidFencesAsync(
  markdown: string,
  replace: (fence: MermaidFence) => Promise<string>
): Promise<string> {
  const chunks: string[] = [];
  let cursor = 0;
  for (const fence of mermaidFences(markdown)) {
    chunks.push(markdown.slice(cursor, fence.start), await replace(fence));
    cursor = fence.end;
  }
  chunks.push(markdown.slice(cursor));
  return chunks.join("");
}

interface MarkdownNode {
  readonly type: string;
  readonly lang?: string | null;
  readonly value?: string;
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
  readonly children?: readonly MarkdownNode[];
}
import { fromMarkdown } from "mdast-util-from-markdown";
