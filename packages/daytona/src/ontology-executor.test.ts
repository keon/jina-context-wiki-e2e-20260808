import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Sandbox } from "@daytona/sdk";
import { buildFocusEvidenceBundle } from "./ontology-executor.js";

test("focus evidence streaming stops at the configured byte budget", async () => {
  const previousMaximum = process.env.ONTOLOGY_FOCUS_BUNDLE_MAX_CHARS;
  const previousPerFile = process.env.ONTOLOGY_FOCUS_BUNDLE_FILE_CHARS;
  process.env.ONTOLOGY_FOCUS_BUNDLE_MAX_CHARS = "64";
  process.env.ONTOLOGY_FOCUS_BUNDLE_FILE_CHARS = "64";
  let destroyed = false;
  try {
    const stream = new Readable({
      read() {
        this.push(Buffer.alloc(32, "a"));
        this.push(Buffer.alloc(32, "b"));
        this.push(Buffer.alloc(32, "c"));
      },
      destroy(error, callback) {
        destroyed = true;
        callback(error);
      }
    });
    const fs = {
      downloadFileStream: async () => stream
    } as unknown as Pick<Sandbox["fs"], "downloadFileStream">;
    const result = await buildFocusEvidenceBundle({ fs }, ["src/large.ts"]);
    assert.equal(Buffer.byteLength(result.files[0]?.content ?? ""), 64);
    assert.equal(destroyed, true);
    assert.equal(result.files[0]?.content.includes("c"), false);
  } finally {
    if (previousMaximum === undefined) delete process.env.ONTOLOGY_FOCUS_BUNDLE_MAX_CHARS;
    else process.env.ONTOLOGY_FOCUS_BUNDLE_MAX_CHARS = previousMaximum;
    if (previousPerFile === undefined) delete process.env.ONTOLOGY_FOCUS_BUNDLE_FILE_CHARS;
    else process.env.ONTOLOGY_FOCUS_BUNDLE_FILE_CHARS = previousPerFile;
  }
});
