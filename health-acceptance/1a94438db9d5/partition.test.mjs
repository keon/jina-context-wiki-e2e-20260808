import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionRecords } from './partition.mjs';
test('partitions a remainder in stable input order', () => {
  assert.deepEqual(partitionRecords([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
test('handles empty input and batches larger than the input', () => {
  assert.deepEqual(partitionRecords([], 3), []);
  assert.deepEqual(partitionRecords([1, 2], 5), [[1, 2]]);
});
test('does not mutate the input array', () => {
  const input = Object.freeze([1, 2, 3]);
  assert.deepEqual(partitionRecords(input, 1), [[1], [2], [3]]);
  assert.deepEqual(input, [1, 2, 3]);
});
test('rejects invalid sizes', () => {
  for (const size of [0, -1, 1.5, NaN, Infinity, '2']) {
    assert.throws(() => partitionRecords([1], size), RangeError);
  }
});
test('rejects non-array input', () => {
  assert.throws(() => partitionRecords(null, 1), TypeError);
});
test('rejects Proxy arrays before reading attacker-controlled length', () => {
  let reads = 0;
  const proxy = new Proxy([1], { get(target, name, receiver) { reads++; return Reflect.get(target, name, receiver); } });
  assert.throws(() => partitionRecords(proxy, 1), TypeError);
  assert.equal(reads, 0);
});
test('rejects subclasses without invoking custom species', () => {
  let speciesCalls = 0;
  class Exotic extends Array { static get [Symbol.species]() { speciesCalls++; return Array; } }
  assert.throws(() => partitionRecords(new Exotic(1, 2), 1), TypeError);
  assert.equal(speciesCalls, 0);
});
test('rejects sparse and oversized inputs', () => {
  assert.throws(() => partitionRecords(new Array(3), 1), TypeError);
  assert.throws(() => partitionRecords(new Array(2 ** 32 - 1), 1), RangeError);
});
test('rejects indexed accessors without executing getters', () => {
  const input = [1];
  let reads = 0;
  Object.defineProperty(input, 0, { get() { reads++; return 1; } });
  assert.throws(() => partitionRecords(input, 1), TypeError);
  assert.equal(reads, 0);
});
test('accepts the documented boundary and retains record identity', () => {
  const record = { value: 1 };
  const records = Array(10_000).fill(record);
  const batches = partitionRecords(records, 9999);
  assert.equal(batches[0].length, 9999);
  assert.equal(batches[1].length, 1);
  assert.equal(batches[0][0], record);
});
