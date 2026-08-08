import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";

import {
  configureProductDatabasePool,
  databaseConfigured,
  getPool,
  productDatabaseConfig,
  productDatabaseConnectionString,
} from "./db.js";

test("local product processes use the shared DATABASE_URL", () => {
  assert.equal(
    productDatabaseConnectionString({
      DATABASE_URL: "postgresql://database.example/jina",
    }),
    "postgresql://database.example/jina",
  );
  assert.equal(productDatabaseConnectionString({}), undefined);
});

test("shared mode uses socket credentials and ignores URL configuration", () => {
  assert.deepEqual(
    productDatabaseConfig({
      JINA_PRODUCT_DATABASE_MODE: "shared",
      INSTANCE_UNIX_SOCKET: "/cloudsql/staging:us-east1:jina-db-staging",
      DB_USER: "jina_v2_staging_app",
      DB_PASS: "secret",
      DB_NAME: "jina_staging",
      DATABASE_URL: "postgresql://ignored.example/jina",
    }),
    {
      host: "/cloudsql/staging:us-east1:jina-db-staging",
      user: "jina_v2_staging_app",
      password: "secret",
      database: "jina_staging",
    },
  );
});

test("shared mode fails closed when any v2 credential is missing", () => {
  assert.equal(
    productDatabaseConfig({
      JINA_PRODUCT_DATABASE_MODE: "shared",
      DB_USER: "jina_v2_staging_app",
      DB_PASS: "secret",
      DB_NAME: "jina_staging",
    }),
    undefined,
  );
  assert.throws(
    () => productDatabaseConfig({ JINA_PRODUCT_DATABASE_MODE: "surprise" }),
    /Unsupported JINA_PRODUCT_DATABASE_MODE/,
  );
});

test("a mounted shared pool reuses connections without silently enabling product persistence", () => {
  const sharedPool = {} as Pool;
  configureProductDatabasePool(sharedPool);

  assert.equal(databaseConfigured({}), false);
  assert.equal(databaseConfigured({ DATABASE_URL: "postgresql://localhost/jina_product" }), true);
  assert.equal(getPool(), sharedPool);
});
