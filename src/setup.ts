/**
 * One-shot, idempotent setup/onboarding for cardwright.
 *
 * Run AFTER filling `.env` (see `.env.example`):  `node src/setup.ts`
 *
 * It (read-only first, then the writes you approved):
 *   1. verifies Trello + Telegram credentials,
 *   2. resolves the board (accepts a short link, full URL, or id),
 *   3. ensures the six pipeline lists + a "processed" label exist (creates only
 *      what's missing — safe to re-run),
 *   4. fetches your Telegram chat_id via getUpdates if blank, and sends a test ping,
 *   5. writes the resolved IDs into `cardwright.config.json`.
 *
 * Dependency-free: uses Node's built-in fetch + process.loadEnvFile.
 */

import { writeFileSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const TRELLO_API = "https://api.trello.com/1";

// Pipeline lists, left → right. The keys map onto cardwright.config.json.
const PIPELINE_LISTS: { key: string | null; name: string }[] = [
  { key: null, name: "Inbox" },
  { key: "ready", name: "Ready for Agent" },
  { key: "inProgress", name: "In Progress" },
  { key: "review", name: "In Review" },
  { key: "done", name: "Done" },
  { key: "needsHuman", name: "Needs Human" },
];
const PROCESSED_LABEL = { name: "processed", color: "green" };

const ENV_TEMPLATE = `# cardwright config — fill in the values, then re-run \`cardwright setup\`.
# ── Trello ──
# API key:  https://trello.com/power-ups/admin → "API Key" tab → generate.
TRELLO_API_KEY=
# Token:    open this (substitute YOUR key), click Allow, paste the token:
#   https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=cardwright&key=YOUR_API_KEY
TRELLO_TOKEN=
# Board:    short id or full board URL. The board may be empty — setup creates the lists + label.
TRELLO_BOARD_ID=

# ── Telegram ──
# Bot token: message @BotFather → /newbot → paste the token.
TELEGRAM_BOT_TOKEN=
# Chat id:   message your bot (e.g. /start) then leave blank — setup fetches it. Or paste from @userinfobot.
TELEGRAM_CHAT_ID=

# ── Anthropic (optional) ──
# Worker auth. Required for --bare headless runs and recommended for heavy/unattended/commercial use.
ANTHROPIC_API_KEY=

# ── Optional ──
# PROJECTS_ROOT=~/Projects          # parent folder of your project repos (board name == folder)
# TARGET_INSTALL_CMD=
# TARGET_TEST_CMD=
# TARGET_LINT_CMD=
# TARGET_BUILD_CMD=
`;

/** First-run bootstrap: no .env yet → write a starter template into cwd and stop. */
function scaffoldEnvAndExit(): never {
  const target = resolve(process.cwd(), ".env");
  // We are only here because .env is absent, so this never clobbers an existing file.
  writeFileSync(target, ENV_TEMPLATE);
  // Keep secrets out of git, but only if this is actually a repo.
  try {
    if (existsSync(".git")) {
      const gi = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
      if (!gi.split(/\r?\n/).some((l) => l.trim() === ".env")) {
        appendFileSync(".gitignore", (gi && !gi.endsWith("\n") ? "\n" : "") + ".env\n");
      }
    }
  } catch {
    /* best effort — never block setup on .gitignore */
  }
  console.log(`\n✓ Wrote a starter .env template to:\n    ${target}\n`);
  console.log("Fill in the Trello + Telegram values, then re-run `cardwright setup`.");
  process.exit(1);
}

function loadEnv(): void {
  if (!existsSync(".env")) scaffoldEnvAndExit();
  process.loadEnvFile(".env");
}

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) fail(`Missing ${name} in .env`);
  return v as string;
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") sp.set(k, v);
  return sp.toString();
}

// ── Trello ───────────────────────────────────────────────────────────────────
async function trello(
  method: string,
  path: string,
  params: Record<string, string | undefined>,
  key: string,
  token: string,
): Promise<any> {
  const url = `${TRELLO_API}${path}?${qs({ ...params, key, token })}`;
  const res = await fetch(url, { method });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Trello ${method} ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return body ? JSON.parse(body) : null;
}

/** Accepts a raw id, a short link, or a full board URL. */
function boardRef(input: string): string {
  const m = input.match(/trello\.com\/b\/([^/]+)/i);
  return m ? (m[1] as string) : input;
}

// ── Telegram ─────────────────────────────────────────────────────────────────
async function telegram(token: string, method: string, params: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
  return data.result;
}

export async function main(): Promise<void> {
  loadEnv();
  const key = need("TRELLO_API_KEY");
  const token = need("TRELLO_TOKEN");
  const boardId = boardRef(need("TRELLO_BOARD_ID"));
  const tgToken = need("TELEGRAM_BOT_TOKEN");

  // 1. Verify Trello.
  const me = await trello("GET", "/members/me", { fields: "username,fullName" }, key, token);
  console.log(`✓ Trello auth OK — @${me.username} (${me.fullName})`);

  // 2. Resolve board.
  const board = await trello("GET", `/boards/${boardId}`, { fields: "id,name,url" }, key, token);
  console.log(`✓ Board: "${board.name}" (${board.id})`);

  // 3. Ensure lists + label (idempotent).
  const existingLists: { id: string; name: string }[] = await trello(
    "GET", `/boards/${board.id}/lists`, { fields: "id,name" }, key, token,
  );
  const listIds: Record<string, string> = {};
  for (const spec of PIPELINE_LISTS) {
    let l = existingLists.find((x) => x.name.toLowerCase() === spec.name.toLowerCase());
    if (!l) {
      l = (await trello("POST", `/boards/${board.id}/lists`, { name: spec.name, pos: "bottom" }, key, token)) as { id: string; name: string };
      console.log(`  + created list "${spec.name}"`);
    } else {
      console.log(`  · list "${spec.name}" exists`);
    }
    if (spec.key) listIds[spec.key] = l.id;
  }

  const existingLabels: { id: string; name: string }[] = await trello(
    "GET", `/boards/${board.id}/labels`, { fields: "id,name", limit: "100" }, key, token,
  );
  let label = existingLabels.find((x) => x.name.toLowerCase() === PROCESSED_LABEL.name);
  if (!label) {
    label = (await trello("POST", `/boards/${board.id}/labels`, PROCESSED_LABEL, key, token)) as { id: string; name: string };
    console.log(`  + created label "${PROCESSED_LABEL.name}"`);
  } else {
    console.log(`  · label "${PROCESSED_LABEL.name}" exists`);
  }

  // 4. Telegram verify + chat_id + test ping.
  const bot = await telegram(tgToken, "getMe", {});
  console.log(`✓ Telegram bot OK — @${bot.username}`);
  let chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!chatId) {
    const updates = (await telegram(tgToken, "getUpdates", {})) as any[];
    const withChat = [...updates].reverse().find((u) => u?.message?.chat?.id);
    if (!withChat) {
      fail(
        "No TELEGRAM_CHAT_ID set and getUpdates is empty. Send your bot a message " +
          "(e.g. /start) in Telegram, then re-run. Or set TELEGRAM_CHAT_ID from @userinfobot.",
      );
    }
    chatId = String(withChat.message.chat.id);
    console.log(`✓ Discovered chat_id: ${chatId}`);
  }
  await telegram(tgToken, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: "<b>cardwright</b> hooked up ✅\nSetup verified — board lists + label ready.",
  });
  console.log("✓ Sent Telegram test ping");

  // 5. Write config. Project is keyed by the BOARD NAME (strict: board == folder ==
  // key); repoPath is derived as <projectsRoot>/<board name>.
  const config = {
    concurrency: 1,
    pollIntervalSec: 45,
    workRoot: "~/Library/Application Support/cardwright/scratch",
    projectsRoot: process.env.PROJECTS_ROOT || "~/Projects",
    telegramChatId: chatId,
    repos: {
      [board.name]: {
        defaultBranch: "main",
        installCmd: process.env.TARGET_INSTALL_CMD || "",
        testCmd: process.env.TARGET_TEST_CMD || "",
        lintCmd: process.env.TARGET_LINT_CMD || "",
        buildCmd: process.env.TARGET_BUILD_CMD || "",
        validationCmds: [] as string[],
        autoMerge: false,
        requiredChecks: [] as string[],
        protectedBranch: false,
        deployMode: "pr-only",
        mergeMethod: "merge",
        allowedPaths: ["**"],
        model: "claude-opus-4-8",
        maxBudgetUsd: 15,
        maxFixAttempts: 5,
        timeoutSec: 1800,
        dailyCostCapUsd: 100,
        board: {
          boardId: board.id,
          lists: listIds,
          processedLabelId: label.id,
        },
      },
    },
  };
  writeFileSync("cardwright.config.json", JSON.stringify(config, null, 2) + "\n");
  console.log("\n✓ Wrote cardwright.config.json");
  console.log(`\nSetup complete. Project key = board name "${board.name}" → ${config.projectsRoot}/${board.name}`);
  console.log("Ensure a folder with that exact name exists under projectsRoot (board name == repo folder).");
}

// Entry point is src/cli.ts. No module-load auto-run — importing this file is
// side-effect-free (guarded by src/cli.test.ts).
