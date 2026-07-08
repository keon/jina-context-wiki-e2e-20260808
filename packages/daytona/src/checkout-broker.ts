export interface CheckoutRequest {
  readonly repoUrl: string;
  readonly ref: string;
  readonly workspaceId: string;
}

export interface CheckoutLease {
  readonly workspaceId: string;
  readonly checkoutPath: string;
  readonly expiresAt: string;
}

export interface CheckoutBroker {
  checkout(request: CheckoutRequest): Promise<CheckoutLease>;
  release(workspaceId: string): Promise<void>;
}
