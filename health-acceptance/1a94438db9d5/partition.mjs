/** Split records into bounded batches without mutating the caller's array. */
export function partitionRecords(records, size) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('size must be a positive safe integer');
  const batches = [];
  for (let start = 0; start < records.length; start += size) {
    batches.push(records.slice(start, start + size));
  }
  return batches;
}
