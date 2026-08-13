import assert from "node:assert/strict";
import test from "node:test";

import { quoteShipping } from "../src/shipping.js";

test("domestic orders receive free base shipping at the threshold", () => {
  assert.deepEqual(
    quoteShipping({ subtotalCents: 5000, weightGrams: 800, zone: "domestic" }),
    { currency: "USD", amountCents: 0, freeShippingApplied: true }
  );
});

test("international orders retain the weight surcharge above the threshold", () => {
  assert.deepEqual(
    quoteShipping({ subtotalCents: 7500, weightGrams: 1200, zone: "international" }),
    { currency: "USD", amountCents: 150, freeShippingApplied: true }
  );
});

test("international orders combine base and rounded-up weight pricing", () => {
  assert.equal(
    quoteShipping({ subtotalCents: 2500, weightGrams: 1001, zone: "international" }).amountCents,
    1650
  );
});

test("invalid inputs fail closed", () => {
  assert.throws(
    () => quoteShipping({ subtotalCents: -1, weightGrams: 500, zone: "domestic" }),
    /subtotalCents/
  );
  assert.throws(
    () => quoteShipping({ subtotalCents: 100, weightGrams: 0, zone: "domestic" }),
    /weightGrams/
  );
  assert.throws(
    () => quoteShipping({ subtotalCents: 100, weightGrams: 500, zone: "moon" }),
    /zone/
  );
});
