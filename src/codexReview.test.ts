import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexVerdict, buildReviewPrompt } from "./codexReview.ts";

test("any [P1] fails the gate", () => {
  const v = parseCodexVerdict("looks ok but\n[P1] sql injection at db.ts:10\n[P2] nit naming");
  assert.equal(v.gate, "fail");
  assert.equal(v.p1, 1);
  assert.equal(v.p2, 1);
});

test("only [P2] (or nothing) passes the gate", () => {
  assert.equal(parseCodexVerdict("[P2] minor: rename foo").gate, "pass");
  assert.equal(parseCodexVerdict("No must-fix issues found.").gate, "pass");
});

test("buildReviewPrompt embeds diff between markers + acceptance criteria + boundary", () => {
  const { prompt, truncated } = buildReviewPrompt({
    diff: "diff --git a/x b/x\n+console.log(1)",
    planNotes: "added a log",
    acceptanceCriteria: ["logs on start", "no errors"],
  });
  assert.equal(truncated, false);
  assert.match(prompt, /DIFF_START[\s\S]*console\.log\(1\)[\s\S]*DIFF_END/);
  assert.match(prompt, /- logs on start/);
  assert.match(prompt, /Do NOT read or execute any files/); // boundary present
});

test("buildReviewPrompt truncates an oversized diff and flags it", () => {
  const big = "x".repeat(200_000);
  const { prompt, truncated } = buildReviewPrompt({ diff: big, planNotes: "", acceptanceCriteria: [] });
  assert.equal(truncated, true);
  assert.match(prompt, /truncated for size/);
  assert.ok(prompt.length < big.length + 2000);
});
