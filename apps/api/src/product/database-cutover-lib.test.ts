import assert from "node:assert/strict";
import { test } from "node:test";

import { databaseCutoverPhase, databaseRole, quoteRole } from "./database-cutover-lib.js";

test("database cutover accepts only explicit phases", () => {
  assert.equal(databaseCutoverPhase("prepare"), "prepare");
  assert.equal(databaseCutoverPhase("finalize"), "finalize");
  assert.equal(databaseCutoverPhase("verify"), "verify");
  assert.throws(() => databaseCutoverPhase("drop"), /prepare, finalize, or verify/);
});

test("database cutover rejects injectable role names", () => {
  assert.equal(databaseRole("jina_v2_staging_app", "ROLE"), "jina_v2_staging_app");
  assert.equal(quoteRole("jina_v2_staging_app"), '"jina_v2_staging_app"');
  assert.throws(() => databaseRole('legacy"; drop database jina', "ROLE"), /simple PostgreSQL role/);
  assert.throws(() => databaseRole("", "ROLE"), /simple PostgreSQL role/);
});
