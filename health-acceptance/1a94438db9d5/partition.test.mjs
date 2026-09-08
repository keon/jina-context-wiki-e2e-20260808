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
