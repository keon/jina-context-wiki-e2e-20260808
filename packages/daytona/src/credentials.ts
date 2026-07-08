export interface WorkspaceCredential {
  readonly name: string;
  readonly valueRef: string;
}

export interface CredentialScope {
  readonly workspaceId: string;
  readonly credentials: readonly WorkspaceCredential[];
}
