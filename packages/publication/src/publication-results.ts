export type PublicationStatus = "pending" | "published" | "updated" | "failed" | "superseded";

export interface PublicationResult {
  readonly status: PublicationStatus;
  readonly externalId?: string;
}

