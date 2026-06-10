# Changelog

All notable changes to cardwright are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-rc.1] - 2026-06-10

Hardening release: every fix came out of a full-codebase review and is covered by
new unit tests (10 new, 83 total). Live-validated end-to-end (card → PR) before release.

### Fixed

- Successful runs are no longer flipped to `terminal_failure` when post-run
  reporting fails: the job outcome is recorded in durable state first, and
  Trello/Telegram notifications are best-effort (a transient API blip is not a
  job failure).
- `git fetch` failures now fail the run loudly instead of silently branching
  from a stale `origin/<base>`.
- The Codex review gate counts only line-anchored `[P1]`/`[P2]` markers, so a
  marker quoted mid-sentence (echoed instructions, or a reviewed diff containing
  the literal) can no longer burn retry attempts on false gate failures.
- The Telegram client surfaces the HTTP status on non-JSON responses (e.g. a
  proxy 502 page) instead of throwing an opaque JSON parse error.
- Trello 429 backoff clamps `Retry-After` to at least 1s — a `Retry-After: 0`
  header no longer causes instant retries.
- A missing binary plus queued stdin input can no longer crash the daemon with
  an unhandled stream error.
- `markRunning` extends the job lease to cover a full multi-attempt run and is
  guarded on `state='claimed'`, so a reclaimed job can never be resurrected
  (prerequisite for parallel execution).

### Security

- `cardwright setup` scaffolds `.env` with mode `0600` (owner-only) — it holds
  Trello/Telegram/Anthropic credentials once filled in.
- `NODE_PATH` removed from the scoped subprocess env allowlist (module-injection
  surface; nothing the daemon spawns needs it).
- PR titles and bodies now get exact-value secret redaction (the daemon's known
  tokens), not just pattern-based redaction.
- Per-card daemon log lines are credential-scrubbed before reaching the local log.

### Changed

- Subprocess output buffers cap exactly at `maxBuffer` and append a visible
  `[truncated]` marker instead of silently dropping output past the limit.
- The `mergeMethod` config value is validated (`merge` | `squash` | `rebase`),
  matching how `deployMode` is validated.

## [0.1.0-rc.0] - 2026-06-03

Initial release candidate: working PR-only MVP — Trello card → autonomous
implementation → independent verification → Codex review gate → pull request.
73 unit tests, zero runtime dependencies.
