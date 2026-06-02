/**
 * The cardwright daemon: poll Trello → ingest ready cards (cursor advanced only
 * AFTER durable ingest) → claim (1-per-repo) → runCard → report back to Trello +
 * Telegram. PR-only: success = "In Review" + PR link; failure = "Needs Human" + alert.
 *
 *   node src/daemon.ts --once   # one cycle, then exit (for testing)
 *   node src/daemon.ts          # loop forever at pollIntervalSec
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { loadConfig, loadSecrets, resolveHome, type RepoConfig } from "./config.ts";
import { StateStore } from "./state.ts";
import {
  TrelloClient,
  extractReadyCardEvents,
  maxActionId,
  cardContentHash,
  hasProcessedLabel,
  imageAttachments,
} from "./trello.ts";
import { TelegramClient, escapeHtml } from "./telegram.ts";
import { runCard, branchName } from "./runner.ts";
import { redactSecrets } from "./redact.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const genRunId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const nowIso = () => new Date().toISOString();
const log = (m: string) => console.log(`${nowIso()} ${m}`);
const logErr = (m: string) => console.error(`${nowIso()} ${m}`);

interface Ctx {
  state: StateStore;
  trello: TrelloClient;
  telegram: TelegramClient;
  workRoot: string;
  maxAttempts: number;
  /** Mask credentials in any text bound for Trello/Telegram (untrusted worker output). */
  redact: (s: string) => string;
}

/** Detect ready cards and durably queue them; advance the cursor only afterward. */
async function ingestRepo(ctx: Ctx, repoKey: string, repo: RepoConfig): Promise<number> {
  const boardId = repo.board.boardId;
  const ready = repo.board.lists.ready;
  const cursor = ctx.state.getCursor(boardId);

  if (cursor === null) {
    // First run: queue cards already sitting in "Ready for Agent", then start the
    // cursor at "now" so we don't replay history.
    const cards = await ctx.trello.getCardsInList(ready);
    let queued = 0;
    for (const c of cards) {
      const card = await ctx.trello.getCard(c.id);
      if (hasProcessedLabel(card, repo.board.processedLabelId)) continue;
      if (ctx.state.ingest({ cardId: card.id, contentHash: cardContentHash(card), boardId, repo: repoKey, title: card.name }, Date.now())) queued++;
    }
    const latest = await ctx.trello.latestActionId(boardId);
    ctx.state.setCursor(boardId, latest ?? nowIso(), Date.now());
    return queued;
  }

  const actions = await ctx.trello.actionsSince(boardId, cursor);
  const events = extractReadyCardEvents(actions, ready);
  let queued = 0;
  for (const ev of events) {
    const card = await ctx.trello.getCard(ev.cardId);
    if (card.idList !== ready) continue; // moved out again before we got here
    if (hasProcessedLabel(card, repo.board.processedLabelId)) continue;
    if (ctx.state.ingest({ cardId: card.id, contentHash: cardContentHash(card), boardId, repo: repoKey, title: card.name }, Date.now())) queued++;
  }
  const max = maxActionId(actions);
  if (max) ctx.state.setCursor(boardId, max, Date.now()); // advance AFTER ingest
  return queued;
}

async function processJob(ctx: Ctx, repoKey: string, repo: RepoConfig, job: { cardId: string; contentHash: string; title: string }): Promise<void> {
  const key = { cardId: job.cardId, contentHash: job.contentHash };
  const lists = repo.board.lists;
  const runId = genRunId();
  const branch = branchName(repo.board.boardId, job.cardId, runId);
  const tag = job.cardId.slice(0, 6);
  const log = (m: string) => console.log(`${nowIso()} [${tag}] ${m}`);
  const attachDir = join(ctx.workRoot, ".attachments", `${job.cardId.slice(0, 8)}-${runId}`);
  const imagePaths: string[] = [];

  try {
    ctx.state.markRunning(key, runId, branch, Date.now());
    await ctx.trello.moveCard(job.cardId, lists.inProgress);
    await ctx.trello.commentCard(job.cardId, "🤖 cardwright started on this card.");
    const card = await ctx.trello.getCard(job.cardId);

    // Download image attachments so the worker can SEE them. They live outside the
    // worktree, so they never end up in the diff/PR.
    try {
      const imgs = imageAttachments(await ctx.trello.getAttachments(job.cardId));
      if (imgs.length) {
        mkdirSync(attachDir, { recursive: true });
        for (let i = 0; i < imgs.length; i++) {
          const a = imgs[i]!;
          const dest = join(attachDir, `${i}_${a.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
          writeFileSync(dest, await ctx.trello.downloadAttachment(a.url));
          imagePaths.push(dest);
        }
        log(`downloaded ${imagePaths.length} image attachment(s)`);
      }
    } catch (e) {
      log(`attachment download failed (continuing text-only): ${e instanceof Error ? e.message : e}`);
    }

    // Load (or mint) the project's persistent Claude session, then persist whatever
    // the run ends up using (it may have been (re)created during the run).
    const existingSession = ctx.state.getSession(repoKey);
    const session = existingSession ? { id: existingSession, exists: true } : { id: randomUUID(), exists: false };
    const outcome = await runCard(card, repo, ctx.workRoot, runId, imagePaths, session, { log });
    ctx.state.setSession(repoKey, outcome.sessionId, Date.now());

    if (outcome.status === "pr_open") {
      ctx.state.markPrOpen(key, outcome.prUrl!, outcome.prNumber!, outcome.costUsd, Date.now());
      await ctx.trello.moveCard(job.cardId, lists.review);
      await ctx.trello.attachUrl(job.cardId, outcome.prUrl!, `PR #${outcome.prNumber}`);
      await ctx.trello.commentCard(
        job.cardId,
        ctx.redact(`✅ PR opened: ${outcome.prUrl}\nCodex review: ${outcome.codex?.p1 ?? 0} P1 / ${outcome.codex?.p2 ?? 0} P2 · ${outcome.attempts} attempt(s) · cost $${outcome.costUsd.toFixed(4)}\n\n${outcome.summary}`).slice(0, 16000),
      );
      await ctx.trello.addLabel(job.cardId, repo.board.processedLabelId).catch(() => {});
      await ctx.telegram.send(ctx.redact(`<b>PR ready for review</b> ✅\n${escapeHtml(card.name)}\n${outcome.prUrl}\n${outcome.attempts} attempt(s) · cost $${outcome.costUsd.toFixed(4)}`));
      log(`done → ${outcome.prUrl}`);
    } else {
      ctx.state.markTerminal(key, "terminal_failure", { lastError: outcome.reason, costUsd: outcome.costUsd, prUrl: outcome.prUrl, prNumber: outcome.prNumber }, Date.now());
      await ctx.trello.moveCard(job.cardId, lists.needsHuman);
      if (outcome.prUrl) await ctx.trello.attachUrl(job.cardId, outcome.prUrl, `Draft PR #${outcome.prNumber}`);
      const draft = outcome.prUrl ? `\nDraft PR (work preserved): ${outcome.prUrl}` : "";
      const codex = outcome.codex?.output ? `\n\nCodex:\n${outcome.codex.output.slice(0, 1500)}` : "";
      await ctx.trello.commentCard(job.cardId, ctx.redact(`❌ Could not complete: ${outcome.reason}${draft}${codex}`).slice(0, 16000));
      await ctx.telegram.send(
        ctx.redact(`<b>Needs human</b> ⚠️\n${escapeHtml(card.name)}\n${escapeHtml(outcome.reason ?? "")}${outcome.prUrl ? `\nDraft: ${outcome.prUrl}` : ""}`),
      );
      log(`failed → ${outcome.reason}${outcome.prUrl ? ` (draft ${outcome.prUrl})` : ""}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.state.markTerminal(key, "terminal_failure", { lastError: msg }, Date.now());
    try {
      await ctx.trello.moveCard(job.cardId, lists.needsHuman);
      await ctx.trello.commentCard(job.cardId, ctx.redact(`❌ Daemon error: ${msg.slice(0, 500)}`));
      await ctx.telegram.send(ctx.redact(`<b>Daemon error</b> ⚠️\n${escapeHtml(job.title)}\n${escapeHtml(msg.slice(0, 300))}`));
    } catch {
      /* best effort */
    }
    log(`error → ${msg}`);
  } finally {
    rmSync(attachDir, { recursive: true, force: true });
  }
}

async function cycle(ctx: Ctx, repos: Record<string, RepoConfig>): Promise<void> {
  ctx.state.reclaimExpired(Date.now(), ctx.maxAttempts);
  for (const [repoKey, repo] of Object.entries(repos)) {
    const queued = await ingestRepo(ctx, repoKey, repo);
    if (queued) log(`[poll] ${repoKey}: queued ${queued} card(s)`);
    const leaseMs = repo.timeoutSec * 1000 + 120_000;
    for (let job = ctx.state.claim(repoKey, Date.now(), leaseMs); job; job = ctx.state.claim(repoKey, Date.now(), leaseMs)) {
      await processJob(ctx, repoKey, repo, job);
    }
  }
}

export async function main(opts: { once?: boolean } = {}): Promise<void> {
  const once = opts.once ?? false;
  const config = loadConfig();
  const secrets = loadSecrets();

  const statePath = resolveHome("~/.cardwright/state.sqlite");
  mkdirSync(dirname(statePath), { recursive: true });
  mkdirSync(config.workRoot, { recursive: true });

  const secretValues = [secrets.trelloKey, secrets.trelloToken, secrets.telegramToken, secrets.anthropicKey ?? ""].filter(Boolean);
  const ctx: Ctx = {
    state: new StateStore(statePath),
    trello: new TrelloClient(secrets.trelloKey, secrets.trelloToken),
    telegram: new TelegramClient(secrets.telegramToken, config.telegramChatId),
    workRoot: config.workRoot,
    maxAttempts: 3,
    redact: (s: string) => redactSecrets(s, secretValues),
  };

  log(`cardwright daemon — projectsRoot ${config.projectsRoot}, poll ${config.pollIntervalSec}s${once ? " (--once)" : ""}`);

  // Startup validation: strict board-name == config-key == folder, and a real git repo.
  const repos: Record<string, RepoConfig> = {};
  for (const [name, repo] of Object.entries(config.repos)) {
    try {
      const board = await ctx.trello.getBoard(repo.board.boardId);
      if (board.name !== name) {
        log(`skip "${name}": board is named "${board.name}" — rename it to "${name}" to match (strict name match)`);
        continue;
      }
    } catch (e) {
      log(`skip "${name}": cannot read board (${e instanceof Error ? e.message : e})`);
      continue;
    }
    if (!existsSync(repo.repoPath) || !existsSync(join(repo.repoPath, ".git"))) {
      log(`skip "${name}": ${repo.repoPath} is not a git repo`);
      continue;
    }
    repos[name] = repo;
    log(`project "${name}" → ${repo.repoPath}`);
  }
  if (Object.keys(repos).length === 0) {
    log("no valid projects (board name must match the folder under projectsRoot) — exiting");
    ctx.state.close();
    return;
  }

  if (once) {
    await cycle(ctx, repos);
    ctx.state.close();
    return;
  }
  for (;;) {
    try {
      await cycle(ctx, repos);
    } catch (err) {
      logErr(`[cycle error] ${err instanceof Error ? err.message : err}`);
    }
    await sleep(config.pollIntervalSec * 1000);
  }
}

// Entry point is src/cli.ts. No module-load auto-run — importing this file is
// side-effect-free (guarded by src/cli.test.ts).
