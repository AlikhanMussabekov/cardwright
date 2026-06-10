/**
 * Durable job state for the daemon, on Node's built-in `node:sqlite`.
 *
 * Enforces the invariants Codex's review demanded:
 *  - idempotency: one row per (card_id, content_hash); re-seeing a card never
 *    re-runs it. A card EDIT changes the hash → a fresh job (intended re-run).
 *  - 1-per-repo execution lock: a partial unique index forbids two jobs being
 *    `claimed`/`running` for the same repo at once (race-safe, not optimistic).
 *  - crash recovery: leases expire so a crashed worker's job is reclaimed.
 *  - cursor transaction boundary: the Trello actions cursor is its own table,
 *    advanced only after jobs are durably ingested.
 *
 * Time is injected (`nowMs`) so lease/reclaim logic is deterministic in tests.
 */

import { DatabaseSync } from "node:sqlite";

export type JobState =
  | "queued"
  | "claimed"
  | "running"
  | "pr_open" // PR opened, awaiting human merge (Phase 1 success terminal for the daemon)
  | "terminal_success" // merged (Phase 3)
  | "terminal_failure"
  | "abandoned";

/** States where a worker is actively touching the repo (the 1-per-repo lock). */
export const ACTIVE_STATES = ["claimed", "running"] as const;
/** States meaning "already handled for this content_hash" — do not re-run. */
export const DONE_STATES = ["pr_open", "terminal_success"] as const;

export interface JobKey {
  cardId: string;
  contentHash: string;
}
export interface JobInput extends JobKey {
  boardId: string;
  repo: string;
  title: string;
}
export interface JobRow extends JobInput {
  state: JobState;
  branch: string | null;
  runId: string | null;
  prUrl: string | null;
  prNumber: number | null;
  leaseUntil: number | null;
  attempts: number;
  lastCostUsd: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface DbRow {
  card_id: string;
  content_hash: string;
  board_id: string;
  repo: string;
  title: string;
  state: JobState;
  branch: string | null;
  run_id: string | null;
  pr_url: string | null;
  pr_number: number | null;
  lease_until: number | null;
  attempts: number;
  last_cost_usd: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function toJob(r: DbRow): JobRow {
  return {
    cardId: r.card_id,
    contentHash: r.content_hash,
    boardId: r.board_id,
    repo: r.repo,
    title: r.title,
    state: r.state,
    branch: r.branch,
    runId: r.run_id,
    prUrl: r.pr_url,
    prNumber: r.pr_number,
    leaseUntil: r.lease_until,
    attempts: r.attempts,
    lastCostUsd: r.last_cost_usd,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  card_id      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  board_id     TEXT NOT NULL,
  repo         TEXT NOT NULL,
  title        TEXT NOT NULL,
  state        TEXT NOT NULL,
  branch       TEXT,
  run_id       TEXT,
  pr_url       TEXT,
  pr_number    INTEGER,
  lease_until  INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_cost_usd REAL,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (card_id, content_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_repo
  ON jobs(repo) WHERE state IN ('claimed','running');
CREATE INDEX IF NOT EXISTS jobs_by_repo_state ON jobs(repo, state);

CREATE TABLE IF NOT EXISTS cursor (
  board_id        TEXT PRIMARY KEY,
  seen_action_id  TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trello_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id         TEXT NOT NULL,
  op              TEXT NOT NULL,
  payload         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state           TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_sessions (
  project    TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export interface OutboxItem {
  id: number;
  cardId: string;
  op: string;
  payload: string;
  idempotencyKey: string;
  attempts: number;
}

/** SQLite raises this code for a partial-unique-index violation (repo busy). */
const SQLITE_ERR = "ERR_SQLITE_ERROR";

export class StateStore {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  get(cardId: string, contentHash: string): JobRow | null {
    const r = this.db
      .prepare("SELECT * FROM jobs WHERE card_id=? AND content_hash=?")
      .get(cardId, contentHash) as DbRow | undefined;
    return r ? toJob(r) : null;
  }

  /**
   * Idempotently record a freshly-detected card as `queued`.
   * Returns true if a NEW job was created, false if it already existed
   * (any state) for this exact (card, hash) — the re-detection guard.
   */
  ingest(input: JobInput, nowMs: number): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO jobs (card_id, content_hash, board_id, repo, title, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
         ON CONFLICT(card_id, content_hash) DO NOTHING`,
      )
      .run(input.cardId, input.contentHash, input.boardId, input.repo, input.title, nowMs, nowMs);
    return res.changes > 0;
  }

  /**
   * Claim the oldest queued job for `repo`, taking the 1-per-repo lock.
   * Returns the claimed job, or null if there's nothing queued OR the repo
   * already has an active (claimed/running) job (partial-unique-index guard).
   */
  claim(repo: string, nowMs: number, leaseMs: number): JobRow | null {
    const candidate = this.db
      .prepare(
        "SELECT card_id, content_hash FROM jobs WHERE repo=? AND state='queued' ORDER BY created_at ASC LIMIT 1",
      )
      .get(repo) as Pick<DbRow, "card_id" | "content_hash"> | undefined;
    if (!candidate) return null;

    try {
      const res = this.db
        .prepare(
          `UPDATE jobs SET state='claimed', lease_until=?, attempts=attempts+1, updated_at=?
           WHERE card_id=? AND content_hash=? AND state='queued'`,
        )
        .run(nowMs + leaseMs, nowMs, candidate.card_id, candidate.content_hash);
      if (res.changes === 0) return null; // raced to claimed/gone
    } catch (err) {
      if ((err as { code?: string }).code === SQLITE_ERR) return null; // repo busy
      throw err;
    }
    return this.get(candidate.card_id, candidate.content_hash);
  }

  private setState(key: JobKey, state: JobState, nowMs: number): void {
    this.db
      .prepare("UPDATE jobs SET state=?, updated_at=? WHERE card_id=? AND content_hash=?")
      .run(state, nowMs, key.cardId, key.contentHash);
  }

  /**
   * claimed → running, extending the lease to cover a FULL run (the claim lease only
   * covers claim→start). Guarded on state='claimed' so a reclaimed/abandoned job can
   * never be resurrected. Returns false if the job was no longer claimed.
   */
  markRunning(key: JobKey, runId: string, branch: string, nowMs: number, leaseMs: number): boolean {
    const res = this.db
      .prepare(
        "UPDATE jobs SET state='running', run_id=?, branch=?, lease_until=?, updated_at=? WHERE card_id=? AND content_hash=? AND state='claimed'",
      )
      .run(runId, branch, nowMs + leaseMs, nowMs, key.cardId, key.contentHash);
    return res.changes > 0;
  }

  markPrOpen(key: JobKey, prUrl: string, prNumber: number, costUsd: number, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE jobs SET state='pr_open', pr_url=?, pr_number=?, last_cost_usd=?, lease_until=NULL, updated_at=?
         WHERE card_id=? AND content_hash=?`,
      )
      .run(prUrl, prNumber, costUsd, nowMs, key.cardId, key.contentHash);
  }

  markTerminal(
    key: JobKey,
    state: Extract<JobState, "terminal_success" | "terminal_failure" | "abandoned">,
    opts: { lastError?: string; costUsd?: number; prUrl?: string; prNumber?: number },
    nowMs: number,
  ): void {
    this.db
      .prepare(
        `UPDATE jobs SET state=?, last_error=?, last_cost_usd=COALESCE(?, last_cost_usd),
         pr_url=COALESCE(?, pr_url), pr_number=COALESCE(?, pr_number), lease_until=NULL, updated_at=?
         WHERE card_id=? AND content_hash=?`,
      )
      .run(state, opts.lastError ?? null, opts.costUsd ?? null, opts.prUrl ?? null, opts.prNumber ?? null, nowMs, key.cardId, key.contentHash);
  }

  /**
   * Reclaim jobs whose lease expired: requeue if under maxAttempts, else abandon.
   * Returns the number of rows touched. Call on a timer + at startup.
   */
  reclaimExpired(nowMs: number, maxAttempts: number): number {
    const abandoned = this.db
      .prepare(
        `UPDATE jobs SET state='abandoned', last_error='lease expired (max attempts)', lease_until=NULL, updated_at=?
         WHERE state IN ('claimed','running') AND lease_until IS NOT NULL AND lease_until < ? AND attempts >= ?`,
      )
      .run(nowMs, nowMs, maxAttempts).changes;
    const requeued = this.db
      .prepare(
        `UPDATE jobs SET state='queued', lease_until=NULL, updated_at=?
         WHERE state IN ('claimed','running') AND lease_until IS NOT NULL AND lease_until < ? AND attempts < ?`,
      )
      .run(nowMs, nowMs, maxAttempts).changes;
    return Number(abandoned) + Number(requeued);
  }

  listByState(state: JobState): JobRow[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE state=?").all(state) as unknown as DbRow[]).map(toJob);
  }

  // ── cursor ───────────────────────────────────────────────────────────────
  getCursor(boardId: string): string | null {
    const r = this.db
      .prepare("SELECT seen_action_id FROM cursor WHERE board_id=?")
      .get(boardId) as { seen_action_id: string } | undefined;
    return r ? r.seen_action_id : null;
  }

  setCursor(boardId: string, actionId: string, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO cursor (board_id, seen_action_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(board_id) DO UPDATE SET seen_action_id=excluded.seen_action_id, updated_at=excluded.updated_at`,
      )
      .run(boardId, actionId, nowMs);
  }

  // ── project sessions (persistent per-project Claude session id) ────────────
  getSession(project: string): string | null {
    const r = this.db
      .prepare("SELECT session_id FROM project_sessions WHERE project=?")
      .get(project) as { session_id: string } | undefined;
    return r ? r.session_id : null;
  }

  setSession(project: string, sessionId: string, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO project_sessions (project, session_id, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project) DO UPDATE SET session_id=excluded.session_id, updated_at=excluded.updated_at`,
      )
      .run(project, sessionId, nowMs, nowMs);
  }

  // ── trello outbox ──────────────────────────────────────────────────────────
  enqueueOutbox(cardId: string, op: string, payload: unknown, idempotencyKey: string, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO trello_outbox (card_id, op, payload, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(cardId, op, JSON.stringify(payload), idempotencyKey, nowMs);
  }

  pendingOutbox(limit = 20): OutboxItem[] {
    const rows = this.db
      .prepare(
        "SELECT id, card_id, op, payload, idempotency_key, attempts FROM trello_outbox WHERE state='pending' ORDER BY id ASC LIMIT ?",
      )
      .all(limit) as Array<{
      id: number;
      card_id: string;
      op: string;
      payload: string;
      idempotency_key: string;
      attempts: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      cardId: r.card_id,
      op: r.op,
      payload: r.payload,
      idempotencyKey: r.idempotency_key,
      attempts: r.attempts,
    }));
  }

  markOutboxDone(id: number): void {
    this.db.prepare("UPDATE trello_outbox SET state='done' WHERE id=?").run(id);
  }

  bumpOutboxAttempt(id: number, error: string): void {
    this.db
      .prepare("UPDATE trello_outbox SET attempts=attempts+1, last_error=? WHERE id=?")
      .run(error, id);
  }
}
