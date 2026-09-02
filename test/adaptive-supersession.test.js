import assert from 'node:assert/strict';
import test from 'node:test';
import { currentAdaptiveRevision } from '../src/adaptive-supersession.js';

test('the replacement head exposes revision two', () => {
  assert.equal(currentAdaptiveRevision(), 2);
});
