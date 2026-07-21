export type DomainErrorCode = "invalid_argument" | "not_found" | "forbidden" | "conflict";

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: DomainErrorCode
  ) {
    super(message);
    this.name = "DomainError";
  }
}
