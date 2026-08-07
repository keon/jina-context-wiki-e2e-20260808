"use client";

import { isValidElement, useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { resolveContextMarkdownLink } from "../../lib/context-citations.ts";
import type { ContextCatalogDocument, ContextRelease } from "../../lib/types.ts";

let mermaidLoader: Promise<(typeof import("mermaid"))["default"]> | undefined;

function loadMermaid(): Promise<(typeof import("mermaid"))["default"]> {
  mermaidLoader ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      fontFamily: "ui-sans-serif, system-ui, sans-serif"
    });
    return mermaid;
  });
  return mermaidLoader;
}

function MermaidDiagram({ source }: { readonly source: string }) {
  const reactId = useId();
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const diagramId = `context-mermaid-${reactId.replace(/[^a-z0-9_-]/gi, "")}`;
    setSvg("");
    setError("");
    void loadMermaid()
      .then((mermaid) => mermaid.render(diagramId, source))
      .then(({ svg: rendered }) => {
        if (active) setSvg(rendered);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "The diagram could not be rendered.");
      });
    return () => {
      active = false;
    };
  }, [reactId, source]);

  if (error) {
    return (
      <figure className="knowledge-diagram knowledge-diagram--error">
        <figcaption>Diagram source (rendering failed: {error})</figcaption>
        <pre>
          <code>{source}</code>
        </pre>
      </figure>
    );
  }
  if (svg) {
    return (
      <figure
        className="knowledge-diagram"
        aria-label="Architecture diagram"
        aria-busy={false}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  return (
    <figure className="knowledge-diagram knowledge-diagram--loading" aria-label="Architecture diagram" aria-busy>
      <span>Rendering diagram…</span>
    </figure>
  );
}

function markdownText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "bigint") return String(node);
  if (Array.isArray(node)) return node.map(markdownText).join("");
  return "";
}

function mermaidSource(children: ReactNode): string | undefined {
  if (!isValidElement<{ readonly className?: string; readonly children?: ReactNode }>(children)) return undefined;
  if (!/\blanguage-mermaid\b/.test(children.props.className ?? "")) return undefined;
  return markdownText(children.props.children).replace(/\n$/, "");
}

export function ContextMarkdown({
  bodyMarkdown,
  release,
  document,
  documents,
  onOpen
}: {
  readonly bodyMarkdown: string;
  readonly release: ContextRelease;
  readonly document: ContextCatalogDocument;
  readonly documents: readonly ContextCatalogDocument[];
  readonly onOpen: (documentId: string) => void;
}) {
  const components = useMemo<Components>(
    () => ({
      pre({ children }) {
        const source = mermaidSource(children);
        return source === undefined ? <pre>{children}</pre> : <MermaidDiagram source={source} />;
      },
      a({ children, href, title }) {
        const resolved = resolveContextMarkdownLink(href ?? "", { release, document, documents });
        if (resolved.kind === "unsafe") {
          return <span className="knowledge-prose__invalid-link">{children}</span>;
        }
        if (resolved.kind === "document") {
          return (
            <a
              href={`#context-document-${encodeURIComponent(resolved.documentId)}`}
              title={title}
              onClick={(event) => {
                event.preventDefault();
                onOpen(resolved.documentId);
              }}
            >
              {children}
            </a>
          );
        }
        const opensNewTab = resolved.kind === "source" || resolved.kind === "external";
        return (
          <a href={resolved.href} title={title} target={opensNewTab ? "_blank" : undefined} rel="noreferrer">
            {children}
          </a>
        );
      },
      code({ children, className }) {
        return <code className={className}>{children}</code>;
      }
    }),
    [document, documents, onOpen, release]
  );

  return (
    <section className="knowledge-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {bodyMarkdown}
      </ReactMarkdown>
    </section>
  );
}
