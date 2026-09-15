import { types } from 'node:util';

/** Partition a dense, plain array of at most 10,000 records into plain batches.
 * Proxies, subclasses, sparse arrays, and indexed accessors are unsupported.
 * Records are retained by reference; the caller's array is never mutated.
 */
export function partitionRecords(records, size) {
  if (!Array.isArray(records) || types.isProxy(records) || Object.getPrototypeOf(records) !== Array.prototype) {
    throw new TypeError('records must be a plain non-Proxy array');
  }
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('size must be a positive safe integer');
  const length = records.length;
  if (length > 10_000) throw new RangeError('records cannot exceed 10,000 items');
  const snapshot = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(records, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('records must be dense with data properties');
    }
    snapshot.push(descriptor.value);
  }
  const batches = [];
  for (let start = 0; start < length; start += size) batches.push(snapshot.slice(start, start + size));
  return batches;
}
