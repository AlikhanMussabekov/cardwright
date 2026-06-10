/**
 * Per-card runner (PR-only) with bounded Codex-retry.
 *
 * The DAEMON owns the deterministic critical path; the worker (`claude -p`) only
 * edits code. Nothing the worker self-reports is trusted: the daemon independently
 * runs the repo's test/validation commands and gates on an independent Codex review.
 *
 * On a verify/Codex failure the runner does NOT give up — it feeds the findings
 * back to the worker and tries again (same worktree, changes persist), up to
 * `maxFixAttempts` (default 5). It escalates to a human (draft PR + Needs Human)
 * only when attempts are exhausted, the worker emits `NEEDS_HUMAN:`, or a hard
 * error occurs. Successful runs open a real PR; preserved work is never discarded.
 *
 * Pure helpers (branch naming, PR-URL parsing, allowed-paths globbing, prompt
 * building, evidence formatting) are unit-tested; the orchestration is live-validated.
 */

import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { run, ok, scopedEnv, type RunResult } from "./exec.ts";
import { parseClaudeStream, isBudgetExceeded } from "./claudeResult.ts";
import { runCodexReview, type CodexVerdict } from "./codexReview.ts";
import type { RepoConfig } from "./config.ts";
import { acceptanceCriteria, type TrelloCard } from "./trello.ts";

export interface RunOutcome {
  status: "pr_open" | "failed";
  prUrl?: string;
  prNumber?: number;
  branch: string;
  costUsd: number;
  attempts: number;
  /** The project's Claude session id (may have been (re)created during the run). */
  sessionId: string;
  summary: string;
  reason?: string;
  codex?: CodexVerdict;
}

/** The persistent per-project Claude session, threaded through every worker call. */
export interface ProjectSession {
  id: string;
  exists: boolean; // false → create with --session-id; true → continue with --resume
}

// ── pure helpers ───────────────────────────────────────────────────────────────

export function sanitizeRepo(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function branchName(boardId: string, cardId: string, runId: string): string {
  return `tw/${boardId.slice(0, 8)}/${cardId.slice(0, 8)}/${runId}`;
}

export function worktreePath(workRoot: string, repo: string, cardId: string, runId: string): string {
  return join(workRoot, sanitizeRepo(repo), `${cardId.slice(0, 8)}-${runId}`);
}

export function parsePrUrl(stdout: string): { url: string; number: number } | null {
  const m = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
  return m ? { url: m[0], number: Number(m[1]) } : null;
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // consume the slash after **
      } else {
        re += "[^/]*";
      }
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Every changed file must match at least one allowed-path glob. `**` allows all. */
export function withinAllowedPaths(files: string[], patterns: string[]): { ok: boolean; offending: string[] } {
  if (patterns.includes("**")) return { ok: true, offending: [] };
  const res = patterns.map(globToRegExp);
  const offending = files.filter((f) => !res.some((r) => r.test(f)));
  return { ok: offending.length === 0, offending };
}

export function buildWorkerPrompt(
  card: TrelloCard,
  branch: string,
  worktree: string,
  imagePaths: string[] = [],
  verifyCmds: string[] = [],
  feedback = "",
  attempt = 1,
  maxAttempts = 1,
): string {
  const ac = acceptanceCriteria(card);
  const lines = [
    `You are an autonomous software engineer working in a git worktree at ${worktree}, on branch ${branch}.`,
    "Implement the task below so it satisfies the acceptance criteria. Edit code and add/adjust tests as needed.",
    "Follow the repository's own conventions (its CLAUDE.md, lint rules, existing patterns).",
    "",
    "Hard rules:",
    "- Do NOT run git commit, git push, or open a PR — the orchestrator handles all git/PR steps.",
    "- Do NOT read or modify secrets, .env files, or anything outside this repository.",
    "- Keep changes scoped to what the task needs.",
    "- If you hit a decision you genuinely cannot make (ambiguous requirement, missing access/credentials, or a call only a human should make), end your summary with a line `NEEDS_HUMAN: <one-line reason>` and stop — do not guess.",
    "",
    `TASK: ${card.name}`,
    "",
    `DETAILS:\n${card.desc || "(none)"}`,
    "",
    `ACCEPTANCE CRITERIA:\n${ac.length ? ac.map((a) => `- ${a}`).join("\n") : "(none specified — use your best judgement)"}`,
  ];
  if (attempt > 1 && feedback) {
    lines.push(
      "",
      `>>> FIX ATTEMPT ${attempt} of ${maxAttempts}. Your previous attempt is already in this worktree but was REJECTED. Fix the issues below precisely, without regressing what already worked. Do not start over:`,
      "",
      feedback.slice(0, 6000),
    );
  }
  if (imagePaths.length) {
    lines.push(
      "",
      "REFERENCE IMAGES (attached to the card; use the Read tool on each path to VIEW them — they live outside the repo, do NOT copy them into the repo):",
      ...imagePaths.map((p) => `- ${p}`),
    );
  }
  if (verifyCmds.length) {
    lines.push(
      "",
      "BEFORE you finish, run each of these in the repo and FIX every failure — the orchestrator re-runs them independently and will REJECT your change if any fail:",
      ...verifyCmds.map((c) => `- ${c}`),
    );
  }
  lines.push("", "When finished, end with a concise summary of what you changed and why (advisory notes only).");
  return lines.join("\n");
}

export function formatEvidence(o: {
  testsOk: boolean | null;
  lintOk: boolean | null;
  validationOk: boolean | null;
  codexP1: number;
  codexP2: number;
  costUsd: number;
  attempts: number;
}): string {
  const yn = (b: boolean | null) => (b === null ? "skipped" : b ? "✓" : "✗");
  return [
    "cardwright ran this card:",
    `• tests: ${yn(o.testsOk)}  • lint: ${yn(o.lintOk)}  • validation: ${yn(o.validationOk)}`,
    `• codex review: ${o.codexP1} P1 / ${o.codexP2} P2`,
    `• attempts: ${o.attempts}  • cost: $${o.costUsd.toFixed(4)}`,
  ].join("\n");
}

/** Compact, throttled progress logging from a stream-json line (tool calls + text). */
export function logWorkerEvent(line: string, log: (m: string) => void): void {
  let e: { type?: string; message?: { content?: unknown } };
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (e?.type !== "assistant") return; // ignore partial stream_event / system noise
  const content = e.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content as Array<Record<string, unknown>>) {
    if (b?.type === "tool_use") {
      const arg = toolArg(b.input);
      log(`  → ${String(b.name ?? "tool")}${arg ? `: ${arg}` : ""}`);
    } else if (b?.type === "text" && typeof b.text === "string") {
      const first = b.text.trim().split("\n")[0];
      if (first) log(`  · ${first.slice(0, 100)}`);
    }
  }
}

function toolArg(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const i = input as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "pattern", "url"]) {
    const v = i[k];
    if (typeof v === "string") return v.slice(0, 80);
  }
  return "";
}

// ── orchestration (live-validated) ──────────────────────────────────────────────

export interface RunDeps {
  log: (msg: string) => void;
  /** Masks credentials (known secret values + generic patterns) in outbound text. */
  redact: (s: string) => string;
}

export async function runCard(
  card: TrelloCard,
  repo: RepoConfig,
  workRoot: string,
  runId: string,
  imagePaths: string[],
  session: ProjectSession,
  deps: RunDeps,
): Promise<RunOutcome> {
  const branch = branchName(repo.board.boardId, card.id, runId);
  const repoPath = repo.repoPath;
  const base = repo.defaultBranch;
  const maxAttempts = Math.max(1, repo.maxFixAttempts);
  const log = deps.log;

  let totalCost = 0;
  let notes = "";
  let attempt = 0;
  let switched = false; // true once we've checked out the card branch in the folder
  let sessionId = session.id;
  let sessionExists = session.exists;

  const fail = (reason: string, extra: Partial<RunOutcome> = {}): RunOutcome => ({
    status: "failed",
    branch,
    costUsd: totalCost,
    attempts: attempt,
    sessionId,
    summary: notes,
    reason,
    ...extra,
  });

  try {
    // 1. clean-tree guard, then a fresh branch off latest base — IN the project folder
    const status = await run("git", ["-C", repoPath, "status", "--porcelain"], { timeoutMs: 30_000 });
    if (!ok(status)) return fail(`git status failed (not a repo?): ${status.stderr.slice(0, 200)}`);
    if (status.stdout.trim()) {
      return fail("working tree not clean — in-folder mode needs a clean checkout (commit or stash your changes first)");
    }
    const fetched = await run("git", ["-C", repoPath, "fetch", "origin", base], { timeoutMs: 120_000 });
    if (!ok(fetched)) {
      // A failed fetch would leave origin/<base> stale — branching from it silently
      // builds on outdated code, so fail loud instead.
      return fail(`git fetch origin ${base} failed: ${fetched.stderr.slice(0, 200)}`);
    }
    const co = await run("git", ["-C", repoPath, "checkout", "-B", branch, `origin/${base}`], { timeoutMs: 60_000 });
    if (!ok(co)) return fail(`checkout -B failed: ${co.stderr.slice(0, 200)}`);
    switched = true;
    log(`on ${branch} (in ${repoPath})`);
    if (repo.installCmd) {
      log(`installing deps: ${repo.installCmd}`);
      const inst = await run("bash", ["-c", repo.installCmd], { cwd: repoPath, timeoutMs: 600_000, env: scopedEnv() });
      if (!ok(inst)) return fail(`dependency install failed: ${inst.stderr.slice(0, 300)}`);
    }

    const attachDir = imagePaths.length ? dirname(imagePaths[0]!) : null;
    const verifyCmds = [repo.testCmd, repo.lintCmd, ...repo.validationCmds].filter(Boolean);

    // Run the worker with the persistent project session (create once with
    // --session-id, then --resume), streaming progress. Recovers from the two
    // known session errors (id already-in-use → resume; stale/pruned → recreate).
    const runWorker = async (prompt: string): Promise<RunResult> => {
      const baseArgs = ["-p", prompt, "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--permission-mode", "bypassPermissions", "--add-dir", repoPath];
      if (attachDir) baseArgs.push(attachDir);
      baseArgs.push("--max-budget-usd", String(repo.maxBudgetUsd), "--model", repo.model);
      let r: RunResult | undefined;
      for (let i = 0; i < 2; i++) {
        const sArgs = sessionExists ? ["--resume", sessionId] : ["--session-id", sessionId];
        r = await run("claude", [...baseArgs, ...sArgs], {
          cwd: repoPath,
          timeoutMs: repo.timeoutSec * 1000,
          onLine: (line) => logWorkerEvent(line, log),
          // The worker is a prompt-injection surface: give it ONLY what claude needs to
          // run + authenticate, never the daemon's Trello/Telegram tokens.
          env: scopedEnv({
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
            ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
          }),
        });
        const lower = `${r.stderr}\n${r.stdout}`.toLowerCase();
        if (i === 0 && r.code !== 0 && !sessionExists && /already in use/.test(lower)) {
          sessionExists = true; // it exists → resume instead
          continue;
        }
        if (i === 0 && r.code !== 0 && sessionExists && /(no conversation|no session|session.*not found)/.test(lower)) {
          sessionId = randomUUID(); // stale/pruned → create a fresh session
          sessionExists = false;
          continue;
        }
        break;
      }
      sessionExists = true; // the session is now established for subsequent calls
      return r!;
    };

    const commitPushPr = async (draft: boolean, title: string, body: string): Promise<{ url: string; number: number } | { error: string }> => {
      await run("git", ["-C", repoPath, "add", "-A"], { timeoutMs: 30_000 });
      const c = await run("git", ["-C", repoPath, "commit", "-m", `${card.name}\n\nvia cardwright (card ${card.id})`], { timeoutMs: 30_000 });
      if (!ok(c)) return { error: `commit failed: ${c.stderr.slice(0, 200)}` };
      const p = await run("git", ["-C", repoPath, "push", "-u", "origin", branch], { timeoutMs: 120_000 });
      if (!ok(p)) return { error: `push failed: ${p.stderr.slice(0, 200)}` };
      // The body carries worker notes + Codex output + command tails — untrusted text
      // bound for a semi-public PR. Redact any credential-shaped content before it leaves.
      const args = ["pr", "create", "--title", deps.redact(title), "--body", deps.redact(body).slice(0, 60_000), "--base", base, "--head", branch];
      if (draft) args.push("--draft");
      const pr = await run("gh", args, { cwd: repoPath, timeoutMs: 60_000 });
      const parsed = parsePrUrl(pr.stdout + pr.stderr);
      return parsed ? { url: parsed.url, number: parsed.number } : { error: `gh pr create produced no url: ${(pr.stdout + pr.stderr).slice(0, 200)}` };
    };

    const preserve = async (reason: string, codexVerdict?: CodexVerdict): Promise<RunOutcome> => {
      const body = [
        `⚠️ Automated change preserved as a DRAFT for a human to finish (after ${attempt} attempt(s)).`,
        "",
        `Reason: ${reason}`,
        codexVerdict?.output ? `\nLatest Codex review:\n${codexVerdict.output.slice(0, 2500)}` : "",
        "",
        `Trello card: ${card.id}`,
        "",
        notes,
      ].join("\n");
      const pres = await commitPushPr(true, `[needs-fix] ${card.name}`, body);
      if ("url" in pres) {
        return { status: "failed", branch, costUsd: totalCost, attempts: attempt, sessionId, summary: notes, reason, codex: codexVerdict, prUrl: pres.url, prNumber: pres.number };
      }
      return { status: "failed", branch, costUsd: totalCost, attempts: attempt, sessionId, summary: notes, reason: `${reason} (could not preserve work: ${pres.error})`, codex: codexVerdict };
    };

    const verify = async (label: string, cmd: string): Promise<string | null> => {
      const r = await run("bash", ["-c", cmd], { cwd: repoPath, timeoutMs: repo.timeoutSec * 1000, env: scopedEnv() });
      if (ok(r)) return null;
      const tail = `${r.stdout}\n${r.stderr}`.trim().slice(-1200);
      return `${label} failed (\`${cmd}\`${r.timedOut ? ", timed out" : ""}):\n${tail}`;
    };

    let feedback = "";
    let lastCodex: CodexVerdict | undefined;

    // 2..N. bounded retry: worker → verify → codex, feeding failures back each round
    for (attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt = buildWorkerPrompt(card, branch, repoPath, imagePaths, verifyCmds, feedback, attempt, maxAttempts);
      const startedAt = Date.now();
      const hb = setInterval(
        () => log(`  … still working — ${Math.round((Date.now() - startedAt) / 60000)}m (attempt ${attempt})`),
        60_000,
      );
      let claude: RunResult;
      try {
        claude = await runWorker(prompt);
      } finally {
        clearInterval(hb);
      }
      if (claude.timedOut) return await preserve(`worker timed out on attempt ${attempt}`, lastCodex);
      try {
        const res = parseClaudeStream(claude.stdout);
        totalCost += res.totalCostUsd;
        notes = res.result;
        if (res.isError) return await preserve(`worker errored (${res.subtype})${isBudgetExceeded(res) ? " — budget exceeded" : ""} on attempt ${attempt}`, lastCodex);
      } catch (e) {
        return fail(`could not parse worker output: ${(e as Error).message}`);
      }
      log(`attempt ${attempt}/${maxAttempts}: worker done — cumulative $${totalCost.toFixed(4)}`);

      // worker explicitly asked for help → escalate (a "hard decision")
      const human = notes.match(/NEEDS_HUMAN:\s*(.+)/);
      if (human) return await preserve(`worker requested human help: ${human[1]!.slice(0, 300)}`, lastCodex);

      // stage + inspect the diff (daemon-owned)
      await run("git", ["-C", repoPath, "add", "-A"], { timeoutMs: 30_000 });
      const files = (await run("git", ["-C", repoPath, "diff", "--cached", "--name-only"], { timeoutMs: 30_000 })).stdout
        .split("\n").map((s) => s.trim()).filter(Boolean);
      if (files.length === 0) return fail("worker made no changes");
      const guard = withinAllowedPaths(files, repo.allowedPaths);
      if (!guard.ok) return await preserve(`changed files outside allowedPaths: ${guard.offending.slice(0, 5).join(", ")}`, lastCodex);
      const diff = (await run("git", ["-C", repoPath, "diff", "--cached"], { timeoutMs: 30_000 })).stdout;

      // deterministic verification
      let verifyErr: string | null = null;
      for (const [label, cmd] of [["tests", repo.testCmd], ["lint", repo.lintCmd]] as const) {
        if (cmd) {
          verifyErr = await verify(label, cmd);
          if (verifyErr) break;
        }
      }
      if (!verifyErr) {
        for (const v of repo.validationCmds) {
          verifyErr = await verify("validation", v);
          if (verifyErr) break;
        }
      }
      if (verifyErr) {
        log(`attempt ${attempt}: verify failed`);
        if (attempt < maxAttempts) {
          feedback = verifyErr;
          continue;
        }
        return await preserve(`exhausted ${maxAttempts} attempts; last failure: ${verifyErr}`, lastCodex);
      }
      log(`attempt ${attempt}: verify ok`);

      // independent Codex review gate
      const codex = await runCodexReview({
        repoPath,
        diff,
        planNotes: notes,
        acceptanceCriteria: acceptanceCriteria(card),
        timeoutSec: Math.min(repo.timeoutSec, 600),
      });
      lastCodex = codex;
      log(`attempt ${attempt}: codex ${codex.gate} (${codex.p1} P1 / ${codex.p2} P2)`);
      if (codex.gate === "fail") {
        if (attempt < maxAttempts) {
          feedback = `An independent reviewer (Codex) found ${codex.p1} must-fix [P1] issue(s). Fix each one:\n\n${codex.output}`;
          continue;
        }
        return await preserve(`exhausted ${maxAttempts} attempts; Codex still finds ${codex.p1} P1 issue(s)`, codex);
      }

      // success → real PR
      const body = `${formatEvidence({
        testsOk: repo.testCmd ? true : null,
        lintOk: repo.lintCmd ? true : null,
        validationOk: repo.validationCmds.length ? true : null,
        codexP1: codex.p1,
        codexP2: codex.p2,
        costUsd: totalCost,
        attempts: attempt,
      })}\n\nTrello card: ${card.id}\n\n${notes}`;
      const pres = await commitPushPr(false, card.name, body);
      if ("error" in pres) return fail(pres.error, { codex });
      log(`PR ${pres.url} (attempt ${attempt})`);
      return { status: "pr_open", prUrl: pres.url, prNumber: pres.number, branch, costUsd: totalCost, attempts: attempt, sessionId, summary: notes, codex };
    }

    return await preserve(`exhausted ${maxAttempts} attempts`, lastCodex);
  } finally {
    // restore the folder to the base branch (only if we switched it) + drop scratch branch
    if (switched) {
      await run("git", ["-C", repoPath, "checkout", "-f", base], { timeoutMs: 30_000 });
      await run("git", ["-C", repoPath, "branch", "-D", branch], { timeoutMs: 30_000 });
    }
  }
}
