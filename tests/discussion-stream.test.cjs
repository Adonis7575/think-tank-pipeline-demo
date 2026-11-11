const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, file);
const { createDiscussionParser } = require("../src/lib/discussion-stream.ts");
const roles = ["strategist", "builder", "editor", "strategist"];
const message = (index, text = `Completed turn ${index + 1}`) => ({ type: "message", role: roles[index], sequence: index + 1, text });
const encode = (event) => JSON.stringify(event) + "\n";

test("chunked NDJSON preserves all four handoffs and final completion", () => {
  const received = [];
  const parser = createDiscussionParser((event) => received.push(event));
  const wire = roles.map((_, index) => encode(message(index))).join("") + JSON.stringify({ type: "done" });
  for (let index = 0; index < wire.length; index += 7) parser.push(wire.slice(index, index + 7));
  parser.finish();
  assert.deepEqual(received, [...roles.map((_, index) => message(index)), { type: "done" }]);
});
test("EOF without explicit done remains a failed discussion", () => {
  const received = [];
  const parser = createDiscussionParser((event) => received.push(event));
  parser.push(encode(message(0)));
  assert.throws(() => parser.finish(), /ended early/);
  assert.equal(received.length, 1);
});
test("error events preserve successful earlier turns without inventing completion", () => {
  const received = [];
  const parser = createDiscussionParser((event) => received.push(event));
  parser.push(encode(message(0)) + encode({ type: "error", message: "Local model is busy" }));
  parser.finish();
  assert.deepEqual(received.map((event) => event.type), ["message", "error"]);
});
test("wrong roles, duplicate turns, premature done and invalid JSON fail closed", () => {
  for (const event of [message(1), { ...message(0), role: "administrator" }, { type: "done" }, { type: "delta", text: "unframed" }, null]) {
    assert.throws(() => createDiscussionParser(() => {}).push(encode(event)));
  }
  const parser = createDiscussionParser(() => {});
  parser.push(encode(message(0)));
  assert.throws(() => parser.push(encode(message(0))));
  assert.throws(() => createDiscussionParser(() => {}).push("broken JSON\n"));
});
test("valid turns survive a malformed later update in the same network chunk", () => {
  const received = [];
  const parser = createDiscussionParser((event) => received.push(event));
  assert.throws(() => parser.push(encode(message(0)) + "bad\n"));
  assert.deepEqual(received, [message(0)]);
});
test("transcript and line limits bound memory; terminal frames reject extra data", () => {
  assert.throws(() => createDiscussionParser(() => {}).push(encode(message(0, "a".repeat(6001)))), /transcript limit/);
  assert.throws(() => createDiscussionParser(() => {}).push("a".repeat(64001)), /too large/);
  const parser = createDiscussionParser(() => {});
  parser.push(encode({ type: "error", message: "Unavailable" }));
  assert.throws(() => parser.push(encode(message(0))), /after it ended/);
});
