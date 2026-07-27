import assert from "node:assert/strict";
import { test } from "node:test";
import { assertExactTenantInventory, auditLegacyContextSnapshot } from "./cutover-preflight.js";

test("legacy cutover audit accepts archived terminal work for every inventoried tenant", () => {
  const audits = auditLegacyContextSnapshot(
    snapshot([
      task("tenant-a", "context_graph_project", "done", "cg_done"),
      task("tenant-b", "context-graph-build", "failed", "cg_failed"),
      task("tenant-b", "context_graph_assert", "superseded", "cg_superseded"),
      task("tenant-a", "index-context", "running", "current")
    ]),
    ["tenant-a", "tenant-b"]
  );
  assert.deepEqual(audits, [
    { tenantId: "tenant-a", legacyTaskCount: 1, terminalTaskCount: 1 },
    { tenantId: "tenant-b", legacyTaskCount: 2, terminalTaskCount: 2 }
  ]);
});

test("legacy cutover audit rejects pending work after the old write path is fenced", () => {
  assert.throws(
    () =>
      auditLegacyContextSnapshot(snapshot([task("tenant-a", "context_graph_ingest", "running", "cg_active")]), [
        "tenant-a"
      ]),
    /tenant-a\/cg_active/
  );
});

test("legacy cutover audit rejects pending outbox linked to a terminal graph task", () => {
  assert.throws(
    () =>
      auditLegacyContextSnapshot(
        snapshot(
          [task("tenant-a", "context_graph_project", "done", "cg_done")],
          [{ id: "outbox_pending", taskId: "cg_done", status: "pending" }]
        ),
        ["tenant-a"]
      ),
    /cg_done\/outbox_pending/
  );
});

test("legacy cutover audit rejects orphaned pending legacy topics", () => {
  assert.throws(
    () =>
      auditLegacyContextSnapshot(
        snapshot([], [{ id: "outbox_orphan", taskId: "missing", topic: "run-context-graph-ingest", status: "leased" }]),
        ["tenant-a"]
      ),
    /missing\/outbox_orphan/
  );
});

test("legacy cutover audit rejects malformed legacy outbox status", () => {
  assert.throws(
    () =>
      auditLegacyContextSnapshot(
        snapshot(
          [task("tenant-a", "context_graph_project", "done", "cg_done")],
          [{ id: "outbox_malformed", taskId: "cg_done" }]
        ),
        ["tenant-a"]
      ),
    /cg_done\/outbox_malformed/
  );
});

test("legacy cutover audit rejects an incomplete tenant inventory", () => {
  assert.throws(
    () =>
      auditLegacyContextSnapshot(snapshot([task("tenant-b", "context_graph_project", "done", "cg_done")]), [
        "tenant-a"
      ]),
    /inventory is incomplete: tenant-b/
  );
});

test("legacy cutover audit rejects a missing persisted API snapshot", () => {
  assert.throws(() => auditLegacyContextSnapshot(undefined, ["tenant-a"]), /persisted API snapshot is missing/);
});

test("legacy cutover audit requires an exact authoritative active-tenant inventory", () => {
  assert.doesNotThrow(() => assertExactTenantInventory(["tenant-b", "tenant-a"], ["tenant-a", "tenant-b"]));
  assert.throws(
    () => assertExactTenantInventory(["tenant-a", "tenant-extra"], ["tenant-a", "tenant-b"]),
    /missing=tenant-b; unexpected=tenant-extra/
  );
});

function snapshot(tasks: Record<string, unknown>[], outbox: Record<string, unknown>[] = []): Record<string, unknown> {
  return { intakeState: { board: { tasks, outbox } } };
}

function task(tenantId: string, type: string, status: string, id: string): Record<string, unknown> {
  return { id, type, status, metadata: { tenantId } };
}
