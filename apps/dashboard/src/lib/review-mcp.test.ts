import assert from "node:assert/strict";
import test from "node:test";
import { reviewMcpActivity } from "./review-mcp.ts";
import type { BoardState, BoardTask } from "./types.ts";

const root: BoardTask = { id: "review", type: "pr_review", title: "Review", status: "done", attempt: 1 };
const pass: BoardTask = {
  id: "pass",
  type: "review_pass",
  title: "Pass",
  status: "done",
  attempt: 1,
  parentTaskId: root.id,
  metadata: { mcpServersEnabled: ["github", { name: "context-graph" }] }
};
const board: BoardState = { tasks: [root, pass], dependencies: [], publications: [] };

test("collects MCP configuration and usage from a review pass when inspecting its review", () => {
  assert.deepEqual(
    reviewMcpActivity(root, board, [
      {
        id: "event",
        taskId: pass.id,
        type: "review.completed",
        at: "2026-07-22T12:00:00Z",
        payload: {
          mcpUsageEvents: [{ server: "github", tool: "get_pull_request", status: "success" }]
        }
      }
    ]),
    {
      enabledServers: ["context-graph", "github"],
      usageEvents: [
        {
          server: "github",
          tool: "get_pull_request",
          status: "success",
          at: "2026-07-22T12:00:00Z"
        }
      ]
    }
  );
});

test("reads MCP data nested in a completion result and infers used servers", () => {
  assert.deepEqual(
    reviewMcpActivity(pass, board, [
      {
        id: "event",
        taskId: pass.id,
        type: "review.completed",
        at: "2026-07-22T12:00:00Z",
        payload: { result: { mcpToolCalls: [{ serverName: "slack", toolName: "search", summary: "Found 2" }] } }
      }
    ]).enabledServers,
    ["context-graph", "github", "slack"]
  );
});
