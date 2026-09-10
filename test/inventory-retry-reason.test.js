import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inventoryRetryReason } from '../src/inventory-retry-reason.js';

test('inventory retry reasons retain distinct operational categories', () => {
  for (const [code, category] of [
    ['insufficient_credits', 'funding'],
    ['tenant_wiki_quota', 'quota'],
    ['wiki_retry_provider_unavailable', 'provider'],
    ['wiki_retry_incompatible', 'saved-work'],
  ]) assert.equal(inventoryRetryReason(code), category);
});

test('unknown and inherited property names remain unknown', () => {
  for (const code of ['', 'new_failure', 'constructor', '__proto__', 'toString']) {
    assert.equal(inventoryRetryReason(code), 'unknown');
  }
});

test('non-string failure codes are rejected', () => {
  for (const code of [undefined, null, 42, {}, ['insufficient_credits']]) {
    assert.throws(() => inventoryRetryReason(code), TypeError);
  }
});
