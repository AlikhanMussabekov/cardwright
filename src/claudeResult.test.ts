import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeJsonOutput, parseClaudeStream, isBudgetExceeded } from "./claudeResult.ts";

// Mirrors the real shape captured from claude 2.1.159 during the capability probe.
const REAL_SHAPE = [
  { type: "system", subtype: "init", session_id: "19f9b849", cwd: "/tmp" },
  { type: "assistant", message: { role: "assistant" } },
  { type: "rate_limit_event" },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "PROBE_OK",
    session_id: "19f9b849",
    total_cost_usd: 0.0865775,
    num_turns: 1,
    stop_reason: "end_turn",
  },
];

test("parses the result event from the real claude json array shape", () => {
  const r = parseClaudeJsonOutput(JSON.stringify(REAL_SHAPE));
  assert.equal(r.result, "PROBE_OK");
  assert.equal(r.sessionId, "19f9b849");
  assert.equal(r.isError, false);
  assert.equal(r.subtype, "success");
  assert.equal(r.numTurns, 1);
  assert.equal(r.stopReason, "end_turn");
  assert.ok(Math.abs(r.totalCostUsd - 0.0865775) < 1e-9);
});

test("throws when there is no result event (fail closed)", () => {
  const raw = JSON.stringify([{ type: "system", subtype: "init" }]);
  assert.throws(() => parseClaudeJsonOutput(raw), /no result event/);
});

test("throws on empty output", () => {
  assert.throws(() => parseClaudeJsonOutput("   "), /no output/);
});

test("throws on invalid JSON", () => {
  assert.throws(() => parseClaudeJsonOutput("not json at all"), /not valid JSON/);
});

test("flags is_error and budget-exceeded terminations", () => {
  const raw = JSON.stringify([
    {
      type: "result",
      subtype: "error_max_budget",
      is_error: true,
      result: "",
      session_id: "x",
      total_cost_usd: 15.2,
      terminal_reason: "budget_exceeded",
    },
  ]);
  const r = parseClaudeJsonOutput(raw);
  assert.equal(r.isError, true);
  assert.equal(isBudgetExceeded(r), true);
});

test("parseClaudeStream extracts the result from NDJSON, ignoring noise lines", () => {
  const nd = [
    JSON.stringify({ type: "system", subtype: "init" }),
    "garbage not json",
    "",
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "DONE", session_id: "s9", total_cost_usd: 0.5 }),
  ].join("\n");
  const r = parseClaudeStream(nd);
  assert.equal(r.result, "DONE");
  assert.equal(r.sessionId, "s9");
  assert.equal(r.isError, false);
});

test("parseClaudeStream fails closed when there is no result line", () => {
  assert.throws(() => parseClaudeStream(JSON.stringify({ type: "system" })), /no result event/);
  assert.throws(() => parseClaudeStream("   "), /no output/);
});

test("tolerates a bare single result object (not wrapped in an array)", () => {
  const raw = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    session_id: "s1",
    total_cost_usd: 0.01,
  });
  const r = parseClaudeJsonOutput(raw);
  assert.equal(r.result, "ok");
  assert.equal(r.sessionId, "s1");
});
