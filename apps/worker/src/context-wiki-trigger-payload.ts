export interface GenerateWikiPayloadV1<TRequest extends Record<string, unknown> = Record<string, unknown>> {
  readonly schemaVersion: 1;
  readonly requestDigest: string;
  readonly dispatchNonce: string;
  readonly attempt: number;
  readonly request: TRequest;
}

/** Builds the versioned envelope consumed by Trigger.dev's generate-wiki parser. */
export function generateWikiPayload<TRequest extends Record<string, unknown>>(input: {
  readonly request: TRequest;
  readonly requestDigest: string;
  readonly dispatchNonce: string;
  readonly attempt: number;
}): GenerateWikiPayloadV1<TRequest> {
  return {
    schemaVersion: 1,
    requestDigest: input.requestDigest,
    dispatchNonce: input.dispatchNonce,
    attempt: input.attempt,
    request: input.request
  };
}
