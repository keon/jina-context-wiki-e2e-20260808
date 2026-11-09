import test from 'node:test';
import assert from 'node:assert/strict';
import { shippingCents } from './shipping.mjs';

test('small orders pay shipping', () => assert.equal(shippingCents(2500), 499));
test('large orders ship free', () => assert.equal(shippingCents(7500), 0));
test('invalid inputs are rejected', () => {
  for (const input of [-1, 1.5, NaN, Infinity, '5000']) assert.throws(() => shippingCents(input), TypeError);
});
