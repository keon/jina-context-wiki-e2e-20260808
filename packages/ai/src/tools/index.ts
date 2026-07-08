export type ToolCapability = "repo.read" | "docs.read" | "task.write" | "github.publish";

export interface ToolGrant {
  readonly capability: ToolCapability;
  readonly reason: string;
}
