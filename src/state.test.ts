import test from "node:test";
import assert from "node:assert/strict";
import { StateStore } from "./state.ts";

const base = { boardId: "b1", repo: "org/repo", title: "t" };
const mk = () => new StateStore(":memory:");

test("ingest is idempotent per (cardId, contentHash); a card edit re-queues", () => {
  const s = mk();
  assert.equal(s.ingest({ cardId: "c1", contentHash: "h1", ...base }, 1), true);
  assert.equal(s.ingest({ cardId: "c1", contentHash: "h1", ...base }, 2), false); // re-detection guard
  assert.equal(s.ingest({ cardId: "c1", contentHash: "h2", ...base }, 3), true); // edited → new job
  s.close();
});

test("claim takes the oldest queued job and enforces 1-per-repo", () => {
  const s = mk();
  s.ingest({ cardId: "c1", contentHash: "h1", ...base }, 1);
  s.ingest({ cardId: "c2", contentHash: "h1", ...base }, 2);
  const j1 = s.claim("org/repo", 10, 1000);
  assert.ok(j1);
  assert.equal(j1.cardId, "c1"); // oldest first
  assert.equal(j1.state, "claimed");
  assert.equal(j1.attempts, 1);
  assert.equal(s.claim("org/repo", 11, 1000), null); // repo busy
  s.close();
});

test("claim returns null when nothing is queued", () => {
  const s = mk();
  assert.equal(s.claim("org/repo", 1, 1000), null);
  s.close();
});

test("different repos can be claimed concurrently", () => {
  const s = mk();
  s.ingest({ cardId: "c1", contentHash: "h", boardId: "b", repo: "org/a", title: "t" }, 1);
  s.ingest({ cardId: "c2", contentHash: "h", boardId: "b", repo: "org/b", title: "t" }, 2);
  assert.ok(s.claim("org/a", 10, 1000));
  assert.ok(s.claim("org/b", 11, 1000));
  s.close();
});

test("pr_open frees the repo lock so the next card can run", () => {
  const s = mk();
  s.ingest({ cardId: "c1", contentHash: "h1", ...base }, 1);
  s.ingest({ cardId: "c2", contentHash: "h1", ...base }, 2);
  const j1 = s.claim("org/repo", 10, 1000);
  assert.ok(j1);
  s.markRunning(j1, "run1", "tw/b1/c1/r1", 11);
  s.markPrOpen(j1, "https://gh/pr/1", 1, 0.5, 12);
  assert.equal(s.get("c1", "h1")?.state, "pr_open");
  const j2 = s.claim("org/repo", 13, 1000);
  assert.ok(j2);
  assert.equal(j2.cardId, "c2");
  s.close();
});

test("reclaimExpired requeues under maxAttempts, abandons at/over", () => {
  const s = mk();
  s.ingest({ cardId: "c1", contentHash: "h1", ...base }, 1);
  const j = s.claim("org/repo", 10, 100); // lease_until=110, attempts=1
  assert.ok(j);
  s.markRunning(j, "r", "b", 11);
  assert.equal(s.reclaimExpired(50, 3), 0); // not expired
  assert.equal(s.reclaimExpired(200, 3), 1); // expired, attempts 1 < 3 → requeue
  assert.equal(s.get("c1", "h1")?.state, "queued");
  const j2 = s.claim("org/repo", 300, 10); // attempts → 2
  assert.equal(j2?.attempts, 2);
  assert.equal(s.reclaimExpired(400, 2), 1); // attempts 2 >= 2 → abandoned
  assert.equal(s.get("c1", "h1")?.state, "abandoned");
  s.close();
});

test("cursor round-trips and updates", () => {
  const s = mk();
  assert.equal(s.getCursor("b1"), null);
  s.setCursor("b1", "action-100", 1);
  assert.equal(s.getCursor("b1"), "action-100");
  s.setCursor("b1", "action-200", 2);
  assert.equal(s.getCursor("b1"), "action-200");
  s.close();
});

test("outbox enqueues idempotently, drains, marks done", () => {
  const s = mk();
  s.enqueueOutbox("c1", "comment", { text: "hi" }, "c1:comment:1", 1);
  s.enqueueOutbox("c1", "comment", { text: "hi" }, "c1:comment:1", 2); // dup key ignored
  const pending = s.pendingOutbox();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.op, "comment");
  s.markOutboxDone(pending[0]!.id);
  assert.equal(s.pendingOutbox().length, 0);
  s.close();
});

test("project session get/set round-trips", () => {
  const s = mk();
  assert.equal(s.getSession("my-app"), null);
  s.setSession("my-app", "uuid-1", 1);
  assert.equal(s.getSession("my-app"), "uuid-1");
  s.setSession("my-app", "uuid-2", 2);
  assert.equal(s.getSession("my-app"), "uuid-2");
  s.close();
});

test("markTerminal records failure with the error", () => {
  const s = mk();
  s.ingest({ cardId: "c1", contentHash: "h1", ...base }, 1);
  const j = s.claim("org/repo", 10, 1000);
  assert.ok(j);
  s.markTerminal(j, "terminal_failure", { lastError: "codex P1" }, 11);
  const row = s.get("c1", "h1");
  assert.equal(row?.state, "terminal_failure");
  assert.equal(row?.lastError, "codex P1");
  s.close();
});
