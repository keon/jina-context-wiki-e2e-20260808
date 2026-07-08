export type Capability =
  | "can_read_repo"
  | "can_read_pr_diff"
  | "can_clone_repo"
  | "can_create_tasks"
  | "can_request_context"
  | "can_attach_context"
  | "can_fetch_external_docs"
  | "can_publish_review";

export function hasCapability(capabilities: readonly Capability[], capability: Capability): boolean {
  return capabilities.includes(capability);
}

