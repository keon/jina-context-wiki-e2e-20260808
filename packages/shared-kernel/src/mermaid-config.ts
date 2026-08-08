/** One browser-safe Mermaid contract shared by generation and rendering. */
export const contextMermaidVersion = "11.16.1" as const;

export const contextMermaidConfig = {
  startOnLoad: false,
  securityLevel: "strict",
  theme: "dark",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  maxTextSize: 32_768
} as const;

export const contextMermaidConfigDigest = "6c7da0fbe48b2b37d46d69a6ab5deeff9ae0bb1b15192bef8886ed100f9e473b" as const;

export const contextMermaidForbiddenDirective =
  /%%\s*\{|\b(?:click|href|callback|call|image|img)\b|(?:https?:|data:|file:|\/\/)|<\/?(?:script|iframe|object|embed|style|img)\b/i;
