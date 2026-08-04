import assert from "node:assert/strict";
import { test } from "node:test";

import { productDatabaseConnectionString } from "./db.js";

test("the absorbed product database uses its namespaced URL instead of the Context database URL", () => {
  assert.equal(
    productDatabaseConnectionString({
      JINA_PRODUCT_DATABASE_URL: "postgresql://product.example/jina_product",
      DATABASE_URL: "postgresql://context.example/jina_context",
    }),
    "postgresql://product.example/jina_product",
  );
});

test("the product database keeps DATABASE_URL as a local migration compatibility fallback", () => {
  assert.equal(
    productDatabaseConnectionString({ DATABASE_URL: "postgresql://localhost/jina_product" }),
    "postgresql://localhost/jina_product",
  );
  assert.equal(productDatabaseConnectionString({}), undefined);
});
