# Security Policy

cardwright runs an **autonomous coding agent with broad local privileges** against repositories you point it at, driven by a Trello board. That makes its security posture load-bearing, and this document is explicit about what is *enforced*, what is *advisory*, and what is *out of scope*.

If you operate cardwright, please read [Threat model](#threat-model) and [Known limitations](#known-limitations--accepted-risks) before pointing it at anything you care about.

---

## Supported versions

cardwright is **pre-1.0**. Security fixes land on `main` and the published `rc` dist-tag only.

| Version | Supported |
|---|---|
| `main` / `cardwright@rc` (latest) | ✅ |
| anything older | ❌ — upgrade to the latest |

---

## Reporting a vulnerability

**Please report privately — do not open a public issue for a security bug.**

Use [**GitHub Security Advisories**](https://github.com/AlikhanMussabekov/cardwright/security/advisories/new) on this repository (Security → Advisories → *Report a vulnerability*). That keeps the report private until a fix is available.

Helpful things to include:
- affected file/function and version (commit hash),
- a concrete exploit path or proof-of-concept,
- the impact (what an attacker gains), and
- a suggested fix if you have one.

**Expectations.** This is an early-stage, single-maintainer project — there is no formal SLA. I aim to acknowledge a report within a few days and to fix or document confirmed issues promptly. Good-faith security research is welcome; please don't run tests against boards, repos, or credentials that aren't yours, and avoid actions that could destroy data or degrade service for others. Coordinated disclosure is appreciated — give a reasonable window before publishing.

---

## Threat model

cardwright is a **local, single-operator tool**, not a multi-tenant service. Its model assumes:

**Trusted**
- your machine and OS user account,
- your credentials (`TRELLO_*`, `TELEGRAM_BOT_TOKEN`, optional `ANTHROPIC_API_KEY`, and your `git`/`gh` auth),
- the repositories you explicitly configure under `projectsRoot`.

**Untrusted — treated as adversarial / prompt-injection input**
- Trello **card content** (title, description, checklist items),
- Trello **attachments and their URLs**,
- the worker's own output and self-report,
- anything a target repo's **build/test scripts** or **dependencies** could do at runtime.

**Explicitly out of scope (today)**
- **OS-level isolation of the worker.** The worker runs with your user's privileges in your real checkout. cardwright does **not** sandbox it from your machine. Point it only at repos you own and trust. (Isolation is the top roadmap item.)
- **Multi-tenant / shared-board hardening.** The supported posture is a private, single-operator board. A shared board widens the trusted set to everyone with write access.
- **Protecting you from a repo you chose to operate on.** cardwright minimizes blast radius, but if you point it at a hostile repository, a malicious build script still runs as you.

The guiding principle: **the model is never its own safety authority.** Security decisions live in deterministic daemon code, never in a prompt the agent could be talked out of.

---

## Security architecture

### Enforced controls (code, not prompts)

- **Daemon-owned critical path.** Branch, install, test, push, and PR are run by the daemon, not the worker. The daemon independently re-runs your `testCmd` / `validationCmds`; the worker's claim of success is ignored.
- **Independent review gate, fail-closed.** Every diff is reviewed by a *separate* model (OpenAI Codex, `--sandbox read-only`) before any push. Any `[P1]` finding blocks the push. A timeout, a non-zero exit, or an empty diff also **fails closed** — an absent verdict is never treated as a pass.
- **PR-only.** The worker cannot merge — the daemon always opens a pull request (a real PR on success, a draft on failure) and a human merges. Auto-merge is **not implemented**: the `autoMerge` config field is accepted and validated against a config invariant (it can only be set together with branch protection + required checks), but nothing in the daemon acts on it.
- **Path containment.** `allowedPaths` globs reject any diff that touches files outside the configured set (default `**` allows all — narrow it for untrusted-ish repos).
- **Least-privilege subprocess environment.** The worker, the target repo's build/test scripts, and Codex are spawned with a **scoped environment** (an allowlist of `PATH`/`HOME`/locale-type vars). They do **not** inherit your `TRELLO_*` or `TELEGRAM_BOT_TOKEN`. The worker additionally receives `ANTHROPIC_API_KEY` (which it needs); Codex and repo scripts receive neither. This means a prompt-injected worker or a poisoned dependency cannot read those tokens out of the environment and exfiltrate them.
- **Credential-safe attachment download.** Only Trello-hosted *uploads* are fetched, and the Trello OAuth credential is sent **only** to `*.trello.com` hosts over HTTPS. A linked/attacker-supplied attachment URL is never fetched with credentials and cannot be used for SSRF.
- **Outbound redaction.** Text bound for a PR body, a Trello comment, or a Telegram message is scrubbed for credential patterns (and the daemon's own known secret values) before it leaves the process.
- **Review boundary.** The Codex review prompt instructs it to ignore agent-config directories (`~/.claude`, `.claude/skills`, etc.) and to treat the diff as data, not instructions.
- **Process hygiene.** Subprocesses run in their own process group and are killed as a group on timeout, so a runaway worker (and anything it spawned) is reaped, not orphaned. Per-card spend is bounded by `maxBudgetUsd × maxFixAttempts`.

### Advisory controls (defense in depth, not guarantees)

- The worker prompt instructs it not to read secrets/`.env` or touch anything outside the repo. This is a *soft* instruction — the **enforced** backstops are the scoped environment (the tokens aren't reachable) and the `allowedPaths` diff guard. Do not rely on the prompt alone.

### Secrets handling

- Secrets live in `.env`, which is git-ignored; `setup` adds `.env` to `.gitignore` when it scaffolds one. cardwright does not log secret values, and Trello API errors log request *paths*, not the credentialed URL.
- The jobs/session database (`~/.cardwright/state.sqlite`) stores Trello/board IDs and Claude session IDs — not your API tokens.
- **Rotate** any credential you suspect was exposed: Trello key/token at `trello.com/power-ups/admin`, the Telegram bot token via `@BotFather`, and your Anthropic key in the Anthropic console.

---

## Known limitations & accepted risks

- **No OS sandbox yet.** `--permission-mode bypassPermissions` gives the worker your privileges in the checkout. Trusted repos only. (Roadmap: dedicated user / container + scoped tokens.)
- **The worker holds the Anthropic key.** It must, to call the model — so a determined prompt injection could spend against your Anthropic budget. `maxBudgetUsd`, `dailyCostCapUsd`, and `maxFixAttempts` bound the spend; for unattended/commercial use prefer a dedicated API key over your interactive Claude Code session.
- **The review gate is an LLM.** Codex is independent and fail-closed, but it counts `[P1]` markers in model output. It is backstopped by the deterministic test/validation gate and PR-only review, but it is not a formal verifier — treat it as a strong second opinion, not a proof.
- **`node:sqlite` is experimental.** Its API may change across Node releases.
- **Trello tokens are coarse.** Trello does not offer fine-grained per-board tokens; the token you supply can read/write all boards your account can. Use a dedicated account if that blast radius matters.

---

## Hardening recommendations for operators

- Keep boards **private** and single-operator until OS isolation lands.
- Point cardwright **only at repos you own**; review every PR before merging (PR-only is the human gate — keep it).
- Set **`allowedPaths`** as narrowly as the project allows, and keep `autoMerge: false` unless the repo has branch protection + required CI.
- Use a **dedicated `ANTHROPIC_API_KEY`** with a spend cap for unattended runs; tune `maxBudgetUsd` / `dailyCostCapUsd`.
- Run the daemon as a **low-privilege user** without access to credentials beyond what cardwright needs.
- Keep `claude`, `codex`, `gh`, and Node up to date.

---

*This policy describes cardwright's design intent and current controls; it is not a warranty. See [LICENSE](LICENSE) (Apache-2.0) for the terms, including the disclaimer of warranty.*
