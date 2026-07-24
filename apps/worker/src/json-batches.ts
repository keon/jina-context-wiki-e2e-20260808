export interface JsonArrayBatchOptions {
  readonly maximumBytes: number;
  /** Serialized bytes for the complete request envelope with an empty array. */
  readonly emptyPayloadBytes: number;
}

export function serializedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Splits an array so the complete JSON request envelope stays within a byte
 * budget. A single oversized item is returned alone so the server's larger
 * hard limit can accept it or produce one precise terminal error.
 */
export function byteBoundedJsonArrayBatches<T>(
  values: readonly T[],
  options: JsonArrayBatchOptions
): readonly (readonly T[])[] {
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes <= 0) {
    throw new Error("maximumBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(options.emptyPayloadBytes) || options.emptyPayloadBytes < 2) {
    throw new Error("emptyPayloadBytes must include the serialized empty array");
  }

  const envelopeBytes = options.emptyPayloadBytes - 2;
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchBytes = envelopeBytes + 2;

  for (const value of values) {
    const valueBytes = serializedJsonBytes(value);
    const candidateBytes = batchBytes + (batch.length > 0 ? 1 : 0) + valueBytes;
    if (batch.length > 0 && candidateBytes > options.maximumBytes) {
      batches.push(batch);
      batch = [];
      batchBytes = envelopeBytes + 2;
    }
    batchBytes += (batch.length > 0 ? 1 : 0) + valueBytes;
    batch.push(value);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
