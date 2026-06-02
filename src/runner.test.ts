import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeRepo,
  branchName,
  worktreePath,
  parsePrUrl,
  withinAllowedPaths,
  formatEvidence,
  buildWorkerPrompt,
  logWorkerEvent,
} from "./runner.ts";
import type { TrelloCard } from "./trello.ts";

test("branchName uses short ids and a tw/ prefix", () => {
  assert.match(branchName("6a1c268e982f2291", "cardidlong12345", "r1"), /^tw\/6a1c268e\/cardidlo\/r1$/);
});

test("sanitizeRepo replaces unsafe chars", () => {
  assert.equal(sanitizeRepo("Org/Repo name"), "Org_Repo_name");
});

test("worktreePath nests under workRoot/<repo>/<card-run>", () => {
  const p = worktreePath("/wt", "org/repo", "cardid123456", "r1");
  assert.ok(p.startsWith("/wt/org_repo/"));
  assert.ok(p.endsWith("cardid12-r1"));
});

test("parsePrUrl extracts the github PR url + number", () => {
  assert.deepEqual(parsePrUrl("Creating pull request...\nhttps://github.com/Alikhan/repo/pull/42\n"), {
    url: "https://github.com/Alikhan/repo/pull/42",
    number: 42,
  });
  assert.equal(parsePrUrl("no url here"), null);
});

test("withinAllowedPaths: ** allows everything", () => {
  assert.deepEqual(withinAllowedPaths(["a/b.ts", "x.js"], ["**"]), { ok: true, offending: [] });
});

test("withinAllowedPaths enforces directory globs", () => {
  const r = withinAllowedPaths(["src/a.ts", "test/b.ts", "secrets/c.txt"], ["src/**", "test/**"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.offending, ["secrets/c.txt"]);
  assert.equal(withinAllowedPaths(["src/a.ts", "src/deep/b.ts"], ["src/**"]).ok, true);
});

test("withinAllowedPaths single-star does not cross a slash", () => {
  assert.equal(withinAllowedPaths(["a/b.ts"], ["*.ts"]).ok, false);
  assert.equal(withinAllowedPaths(["b.ts"], ["*.ts"]).ok, true);
});

test("buildWorkerPrompt includes the image section only when paths are given", () => {
  const card: TrelloCard = { id: "c", name: "Build screen", desc: "from mockups", idList: "l", labels: [] };
  const withImgs = buildWorkerPrompt(card, "tw/b/c/r", "/wt", ["/tmp/att/0_a.png", "/tmp/att/1_b.png"]);
  assert.match(withImgs, /REFERENCE IMAGES/);
  assert.match(withImgs, /0_a\.png/);
  assert.match(withImgs, /Build screen/);
  assert.doesNotMatch(buildWorkerPrompt(card, "tw/b/c/r", "/wt", []), /REFERENCE IMAGES/);
});

test("buildWorkerPrompt injects fix feedback on retries + always carries the NEEDS_HUMAN rule", () => {
  const card: TrelloCard = { id: "c", name: "Task", desc: "", idList: "l", labels: [] };
  const retry = buildWorkerPrompt(card, "b", "/wt", [], ["bun run test"], "tests failed: foo", 2, 5);
  assert.match(retry, /FIX ATTEMPT 2 of 5/);
  assert.match(retry, /tests failed: foo/);
  assert.match(retry, /NEEDS_HUMAN/);
  assert.doesNotMatch(buildWorkerPrompt(card, "b", "/wt", [], ["bun run test"], "", 1, 5), /FIX ATTEMPT/);
});

test("logWorkerEvent logs tool calls + text from an assistant stream line; ignores noise", () => {
  const out: string[] = [];
  logWorkerEvent(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }, { type: "text", text: "working on it\nmore" }] },
    }),
    (m) => out.push(m),
  );
  assert.ok(out.some((l) => /→ Bash: echo hi/.test(l)));
  assert.ok(out.some((l) => /· working on it/.test(l)));
  const before = out.length;
  logWorkerEvent("not json", (m) => out.push(m)); // no throw
  logWorkerEvent(JSON.stringify({ type: "stream_event" }), (m) => out.push(m)); // ignored
  assert.equal(out.length, before);
});

test("formatEvidence renders a compact status line", () => {
  const s = formatEvidence({ testsOk: true, lintOk: true, validationOk: null, codexP1: 0, codexP2: 2, costUsd: 0.1234, attempts: 3 });
  assert.match(s, /tests: ✓/);
  assert.match(s, /validation: skipped/);
  assert.match(s, /0 P1 \/ 2 P2/);
  assert.match(s, /attempts: 3/);
  assert.match(s, /\$0\.1234/);
});
