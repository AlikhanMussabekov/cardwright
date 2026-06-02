# cardwright

> Ship code by writing a card. An autonomous agent picks it up, implements it, gets it independently reviewed, and leaves a pull request waiting — without you opening an editor.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2024-brightgreen)
![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-success)
![Status](https://img.shields.io/badge/status-release%20candidate-orange)

**cardwright** turns a **Trello board into a remote control for Claude Code**. Drop a card describing what to build; a daemon on your machine claims it, implements it directly in the matching project folder, gates it on your tests **and an independent OpenAI Codex review**, and opens a pull request. You merge.

It's a small, **zero-runtime-dependency** TypeScript daemon that treats each board as both the command input and the live status dashboard, and a local headless `claude` as the executor — one persistent session per project.

> **Status: pre-1.0 (release candidate).** Working PR-only MVP — it has shipped a real card to production end-to-end (implement → verify → independent review → PR → merge → deploy). **73 unit tests, zero runtime dependencies.** Until `0.1.0` is GA on npm, install from the `rc` tag (`cardwright@rc`) or [run from source](#from-source).

---

## Contents

- [Quick start](#quick-start)
- [Requirements](#requirements)
- [How it works](#how-it-works)
- [The board](#the-board)
- [Configuration](#configuration-cardwrightconfigjson)
- [Security model](#security-model)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License & disclaimers](#license)

---

## Quick start

```bash
npx cardwright@rc setup     # 1st run: writes a starter .env into the current folder, then stops
# edit ./.env  (Trello + Telegram secrets — the template it writes has the links/steps)
npx cardwright@rc setup     # 2nd run: verifies creds, creates the board lists + "processed"
                            # label, discovers your Telegram chat_id, sends a test ping, and
                            # writes cardwright.config.json (keyed by the board name)
npx cardwright@rc daemon    # run the loop  (append --once for a single cycle)
```

Run `setup` and `daemon` from your **control directory** — the folder that holds `.env` and `cardwright.config.json`. The daemon then works inside each target repo under `projectsRoot` automatically. The jobs/session database lives at `~/.cardwright/`. Requires **Node ≥ 24**; older Node exits with a clear message.

`.env` (gitignored) holds the secrets — `setup` writes a commented template you fill in:

| Key | What |
|---|---|
| `TRELLO_API_KEY` / `TRELLO_TOKEN` | from `trello.com/power-ups/admin` + the `1/authorize` grant |
| `TRELLO_BOARD_ID` | short id or full board URL (the board may be empty — `setup` creates the lists/label) |
| `TELEGRAM_BOT_TOKEN` | from `@BotFather` |
| `TELEGRAM_CHAT_ID` | leave blank — `setup` discovers it via `getUpdates` |
| `ANTHROPIC_API_KEY` | optional; recommended for heavy/unattended/commercial use |
| `PROJECTS_ROOT` | optional; parent of your project repos (default `~/Projects`) |
| `TARGET_*_CMD` | optional install/test/lint/build commands for the first project |

> **Strict name match:** the Trello board name must equal the repo folder name under `projectsRoot`. e.g. board **`my-app`** ↔ `~/Projects/my-app`. The daemon skips (with a clear log) any project whose board name doesn't match a folder.

### From source

```bash
git clone https://github.com/AlikhanMussabekov/cardwright
cd cardwright
cp .env.example .env       # fill in Trello + Telegram secrets (see comments)
npm run setup              # same onboarding, run against the source
npm run daemon -- --once   # one poll cycle and exit (safe for testing)
npm run daemon             # run forever, polling every pollIntervalSec
```

No build step in development — Node 24 runs the TypeScript directly.

---

## Requirements

- **Node ≥ 24** — uses built-in `node:sqlite`, global `fetch`, and native TypeScript execution (no build step, no `node_modules` at runtime).
- **`claude`** CLI, authenticated — the worker (built against 2.1.x).
- **`codex`** CLI, authenticated — the independent review gate (built against 0.13x).
- **`gh`** CLI, authenticated (PR creation/merge), and **`git`**.
- Whatever toolchain your *target* repos use (e.g. `bun`, `npm`).

> **`node:sqlite` is experimental.** Node prints a one-time `ExperimentalWarning` when the daemon starts, and its API may change across Node releases. This is expected and harmless; `--help`/`--version` don't trigger it.

---

## How it works

```
You (phone)          Trello board                  Your machine (daemon, serial — one card at a time)
 add a card ───▶  Ready for Agent  ── poll ──▶  claim
                                                   │
                                                   ▼
                          in <projectsRoot>/<board-name>:  clean-tree guard → branch off origin/main
                          (resumes the project's persistent Claude session)
                                                   │
                                                   ▼
                          claude -p  (worker edits code only; progress LIVE-STREAMED to the log)
                                                   │
              In Progress ◀──────  daemon-side verify: test / typecheck   (worker's word NOT trusted)
                                                   ▼
                          Codex review (separate model, read-only)
                                            │                │
                                  [P1] found │                │ clean
                                  feed back  │                ▼
                                  & retry    │          push + open PR → restore folder to base
                                  (≤5x)      ▼                │
              Needs Human ◀── exhausted / blocked             ▼
              + draft PR + Telegram                    In Review + Telegram  (you merge → deploy)
```

**Core principle: the model is never its own safety authority.** The daemon owns the deterministic critical path (branch, install, test, push, PR) and independently re-verifies every outcome. An independent model (OpenAI Codex) reviews the diff before any push; a `[P1]` finding fails the gate closed.

**Workspace model.** The daemon is pointed at a **`projectsRoot`** (e.g. `~/Projects`). Each Trello board maps to `<projectsRoot>/<board-name>` by **strict name match** (board name == folder name == config key). It processes cards **serially, directly in the project folder** (no worktrees): clean-tree guard → `git checkout -B <card-branch> origin/main` → work → PR → restore the folder to base.

**Persistent sessions.** Each project has one Claude session that's **created once and `--resume`d on every card** (and across daemon restarts), so the project's agent accumulates context. Stored in the state DB.

**Bounded auto-fix.** On a verify failure or a Codex `[P1]`, the daemon feeds the findings back to the worker and retries in the same checkout (up to `maxFixAttempts`, default 5) — the worker resumes its session, so it remembers the prior attempt. It escalates to a human early only if the worker emits `NEEDS_HUMAN:`, or on a hard error/timeout.

**Work is never wasted.** Any run that can't reach a clean PR is preserved as a **draft PR** (`[needs-fix]`) with the failure reason and Codex's findings, linked on the card.

**PR-only.** The agent opens a PR and you merge — nothing auto-merges. Auto-merge isn't implemented yet (see Roadmap); the `autoMerge` config field is validated against an invariant (branch protection + required CI) but is currently unused.

---

## The board

Lists (created by `setup`): **Inbox** · **Ready for Agent** (the trigger) · **In Progress** · **In Review** (PR open, awaiting your merge) · **Done** · **Needs Human** (dead-letter).

### Card contract
- **Title** — the task summary. **Description** — the spec.
- **Checklist** — acceptance criteria (passed to the worker; where the repo defines executable `validationCmds`, those are the enforceable definition of done).
- **Image attachments** — supported (Trello-hosted uploads). The daemon downloads them outside the repo and the worker views them with its `Read` tool (great for "build this screen from the mockup").

A card is detected when it enters "Ready for Agent" (Trello's actions feed with a durable cursor → processed exactly once; editing a card re-queues it). The board it's on selects the project.

---

## Configuration (`cardwright.config.json`)

```jsonc
{
  "concurrency": 1,                 // serial; >1 not yet executed (see Roadmap)
  "pollIntervalSec": 45,
  "projectsRoot": "~/Projects",     // repoPath defaults to <projectsRoot>/<key>
  "workRoot": "~/Library/Application Support/cardwright/scratch",  // attachment scratch
  "telegramChatId": "-100...",
  "repos": {
    "my-app": {         // == board name == folder under projectsRoot
      "defaultBranch": "main",
      "installCmd": "bun install",  // run once per card (fresh branch)
      "testCmd": "bun run test",    // gate
      "lintCmd": "",                // gate (leave empty to skip; must be NON-interactive!)
      "buildCmd": "bun run build",
      "validationCmds": ["bun run typecheck"],  // extra gate commands
      "autoMerge": false,           // PR-only until earned
      "requiredChecks": [],         // GitHub required checks (needed for autoMerge)
      "protectedBranch": false,     // must be true for autoMerge
      "deployMode": "pr-only",      // pr-only | merge-to-main | ff-only
      "mergeMethod": "merge",
      "allowedPaths": ["**"],       // diffs touching anything outside are rejected
      "model": "claude-opus-4-8",
      "maxBudgetUsd": 15,           // per worker attempt (claude --max-budget-usd)
      "maxFixAttempts": 5,          // bounded Codex/verify retry loop
      "timeoutSec": 1800,
      "dailyCostCapUsd": 100,
      "board": {
        "boardId": "...",
        "lists": { "ready": "...", "inProgress": "...", "review": "...", "done": "...", "needsHuman": "..." },
        "processedLabelId": "..."
      }
      // repoPath is optional — defaults to <projectsRoot>/my-app
    }
  }
}
```

> **Gate commands must pass non-interactively on a clean checkout.** A command that prompts (e.g. the deprecated `next lint`) fails every run. Gate only on commands that already pass on your default branch.

> **In-folder caveat:** the daemon mutates your real checkout (branch switch + restore). It refuses to run on a **dirty working tree** (commit/stash first), and restores the folder to the base branch when done.

> **Cost:** worst case per card ≈ `maxBudgetUsd × maxFixAttempts`. Retries are usually much cheaper than the first attempt, and the loop stops the moment Codex is clean.

---

## Security model

cardwright runs an autonomous agent against your code with broad local permissions, so its security model is deliberate and layered. Card content, attachment URLs, and the target repo's own scripts are all treated as **untrusted, prompt-injection-prone input**.

**What protects you**
- **The model is never the safety authority.** The daemon — not the worker — owns branch/install/test/push/PR and re-runs your test/validation commands independently. The worker's self-report is advisory only.
- **Independent review gate.** A separate model (Codex, read-only) reviews the diff before any push; any `[P1]` fails closed. Timeouts and errors also fail closed (an absent verdict is never a pass).
- **PR-only.** The worker cannot merge. Auto-merge is opt-in per repo and only permitted behind branch protection + required CI.
- **Path containment.** `allowedPaths` rejects any diff that touches files outside the configured globs.
- **Least-privilege subprocess env.** The worker, your repo's build/test scripts, and Codex run with a **scoped environment** — they never inherit your Trello/Telegram tokens (the worker gets only what `claude` needs).
- **Attachment safety.** Only Trello-hosted *uploads* are fetched, and credentials are sent only to Trello hosts — a linked/attacker-supplied attachment URL can't exfiltrate your token or trigger SSRF.
- **Output redaction.** Text bound for PRs, Trello comments, or Telegram is scrubbed for credential patterns.

**Known limits**
- The worker runs with `--permission-mode bypassPermissions` in your real checkout. **Point cardwright only at repos you own and trust** until OS-level worker isolation lands (see Roadmap).
- Single-user / private boards are the supported posture today; a shared board widens the trusted set.

**Reporting a vulnerability:** please open a **private** [GitHub Security Advisory](https://github.com/AlikhanMussabekov/cardwright/security/advisories/new) rather than a public issue.

---

## Project layout

| File | Role |
|---|---|
| `src/cli.ts` | entrypoint: Node-version guard → `route()` → lazy-dispatch `setup` / `daemon` |
| `src/daemon.ts` | the loop: validate projects → poll → ingest (cursor) → claim → run → report |
| `src/runner.ts` | per-card, in-folder: branch → worker (streamed) → verify → Codex gate → retry → PR (+ draft preservation) |
| `src/codexReview.ts` | the independent review gate (`codex exec`, `[P1]` ⇒ fail closed) |
| `src/claudeResult.ts` | parse `claude -p` output — `--output-format json` and `stream-json` |
| `src/state.ts` | `node:sqlite` store: jobs (idempotency, 1-per-repo lock, leases), cursor, outbox, **project sessions** |
| `src/trello.ts` | Trello REST client + detection helpers + credential-safe attachment download |
| `src/telegram.ts` | notifier (HTML, chunked, 429-aware) |
| `src/config.ts` | typed config + secrets loader/validator |
| `src/exec.ts` | subprocess runner (own process group, full-tree kill on timeout, `onLine` streaming, `scopedEnv`) |
| `src/redact.ts` | credential-pattern redaction for outbound text |
| `src/setup.ts` | one-shot onboarding |
| `.claude/skills/cardwright-card/SKILL.md` | the worker's contract |

---

## Roadmap

- [x] Live worker-progress streaming
- [x] Workspace-aware, session-per-project, in-folder execution
- [x] Security hardening — scoped subprocess env, attachment host validation, outbound redaction
- [ ] OS-level worker isolation (dedicated user / container, scoped tokens) — required before untrusted repos
- [ ] Two-way Telegram (approve / unblock / answer from your phone)
- [ ] True parallelism across projects (`concurrency` is wired in config; execution is currently serial)
- [ ] Wire the Trello outbox into the daemon's writes
- [ ] Session compaction/reset after N cards (context growth)
- [ ] Earned per-repo auto-merge behind branch protection + required CI

---

## Contributing

Contributions are welcome. A few invariants keep cardwright small and trustworthy:

- **Zero runtime dependencies.** Node built-ins only (`fetch`, `node:sqlite`, `child_process`). `typescript`/`@types/node` are the only devDeps. PRs that add a runtime dependency need a strong rationale.
- **Tests are not optional.** Pure helpers are unit-tested; orchestration is live-validated. Add tests with your change.
- **The model is never the safety authority** — keep security decisions in deterministic daemon code, never in a prompt.

Local checks (Node ≥ 24):

```bash
npm test            # node --test (73 tests)
npm run typecheck   # tsc --noEmit
npm run build       # tsc -p tsconfig.build.json → dist/
npm run verify-pack # build → assert clean tarball → global-install smoke
```

Dev runs the TypeScript directly (no build); the published package ships compiled `dist/`.

---

## License

[Apache-2.0](LICENSE) © 2026 Alikhan Mussabekov.

## Disclaimers

Not affiliated with, endorsed by, or sponsored by **Anthropic**, **OpenAI**, or **Atlassian / Trello**. "Claude", "Claude Code", "OpenAI", "Codex", and "Trello" are trademarks of their respective owners. cardwright is an independent tool that shells out to those CLIs/APIs using **your own** credentials.

For **heavy, unattended, or commercial** use, authenticate the worker with an `ANTHROPIC_API_KEY` (API billing) rather than interactive Claude Code auth, and review each vendor's terms for automated use.

Built with Claude Code. Independently reviewed by OpenAI Codex.
