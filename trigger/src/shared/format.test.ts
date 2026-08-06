import assert from "node:assert/strict";

import { formatList, pluralize } from "./format.js";

assert.equal(formatList([]), "");
assert.equal(formatList(["a"]), "a");
assert.equal(formatList(["a", "b"]), "a and b");
assert.equal(formatList(["a", "b", "c"]), "a, b, and c");

assert.equal(pluralize(1, "file"), "1 file");
assert.equal(pluralize(2, "file"), "2 files");
