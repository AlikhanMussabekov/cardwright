/**
 * Typed loader + validator for `cardwright.config.json` and `.env` secrets.
 *
 * `parseConfig` is pure (object in → validated Config out) so it's unit-tested;
 * `loadConfig`/`loadSecrets` do the file/env I/O. Validation fails LOUD and
 * EARLY — a misconfigured pipeline must never run with silent defaults.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export type DeployMode = "merge-to-main" | "pr-only" | "ff-only";

export interface BoardConfig {
  boardId: string;
  lists: {
    ready: string;
    inProgress: string;
    review: string;
    done: string;
    needsHuman: string;
  };
  processedLabelId: string;
}

export interface RepoConfig {
  repoPath: string;
  defaultBranch: string;
  installCmd: string;
  testCmd: string;
  lintCmd: string;
  buildCmd: string;
  validationCmds: string[];
  autoMerge: boolean;
  requiredChecks: string[];
  protectedBranch: boolean;
  deployMode: DeployMode;
  mergeMethod: string;
  allowedPaths: string[];
  model: string;
  maxBudgetUsd: number;
  maxFixAttempts: number;
  timeoutSec: number;
  dailyCostCapUsd: number;
  board: BoardConfig;
}

export interface Config {
  concurrency: number;
  pollIntervalSec: number;
  workRoot: string;
  /** Parent folder holding the project repos. repoPath defaults to <projectsRoot>/<name>. */
  projectsRoot: string;
  telegramChatId: string;
  repos: Record<string, RepoConfig>;
}

export interface Secrets {
  trelloKey: string;
  trelloToken: string;
  telegramToken: string;
  telegramChatId: string;
  anthropicKey?: string;
}

const LIST_KEYS = ["ready", "inProgress", "review", "done", "needsHuman"] as const;
const DEPLOY_MODES: DeployMode[] = ["merge-to-main", "pr-only", "ff-only"];
const MERGE_METHODS = ["merge", "squash", "rebase"];

function asObject(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`config: expected ${where} to be an object`);
  }
  return v as Record<string, unknown>;
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`config: ${where} must be a non-empty string`);
  return v;
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Expand a leading `~` to the user's home directory. */
export function resolveHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function parseBoard(name: string, raw: unknown): BoardConfig {
  const b = asObject(raw, `repos.${name}.board`);
  const listsRaw = asObject(b.lists, `repos.${name}.board.lists`);
  const lists = {} as BoardConfig["lists"];
  for (const k of LIST_KEYS) {
    lists[k] = str(listsRaw[k], `repos.${name}.board.lists.${k}`);
  }
  return {
    boardId: str(b.boardId, `repos.${name}.board.boardId`),
    lists,
    processedLabelId: str(b.processedLabelId, `repos.${name}.board.processedLabelId`),
  };
}

function parseRepo(name: string, raw: unknown, projectsRoot: string): RepoConfig {
  const r = asObject(raw, `repos.${name}`);
  const deployMode = strOr(r.deployMode, "pr-only") as DeployMode;
  if (!DEPLOY_MODES.includes(deployMode)) {
    throw new Error(`config: repos.${name}.deployMode must be one of ${DEPLOY_MODES.join(", ")}`);
  }
  const mergeMethod = strOr(r.mergeMethod, "merge");
  if (!MERGE_METHODS.includes(mergeMethod)) {
    throw new Error(`config: repos.${name}.mergeMethod must be one of ${MERGE_METHODS.join(", ")}`);
  }
  // repoPath defaults to <projectsRoot>/<name> (strict: board name == folder == config key).
  const repoPath =
    typeof r.repoPath === "string" && r.repoPath.length > 0
      ? resolveHome(r.repoPath)
      : join(projectsRoot, name);
  const repo: RepoConfig = {
    repoPath,
    defaultBranch: strOr(r.defaultBranch, "main"),
    installCmd: strOr(r.installCmd, ""),
    testCmd: strOr(r.testCmd, ""),
    lintCmd: strOr(r.lintCmd, ""),
    buildCmd: strOr(r.buildCmd, ""),
    validationCmds: strArr(r.validationCmds),
    autoMerge: boolOr(r.autoMerge, false),
    requiredChecks: strArr(r.requiredChecks),
    protectedBranch: boolOr(r.protectedBranch, false),
    deployMode,
    mergeMethod,
    allowedPaths: strArr(r.allowedPaths).length ? strArr(r.allowedPaths) : ["**"],
    model: strOr(r.model, "claude-opus-4-8"),
    maxBudgetUsd: numOr(r.maxBudgetUsd, 15),
    maxFixAttempts: Math.max(1, numOr(r.maxFixAttempts, 5)),
    timeoutSec: numOr(r.timeoutSec, 1800),
    dailyCostCapUsd: numOr(r.dailyCostCapUsd, 100),
    board: parseBoard(name, r.board),
  };
  // Safety invariant: auto-merge is only allowed behind branch protection + checks.
  if (repo.autoMerge && (!repo.protectedBranch || repo.requiredChecks.length === 0)) {
    throw new Error(
      `config: repos.${name}.autoMerge requires protectedBranch:true and a non-empty requiredChecks (earned auto-merge gate)`,
    );
  }
  return repo;
}

export function parseConfig(raw: unknown): Config {
  const o = asObject(raw, "config root");
  const projectsRoot = resolveHome(strOr(o.projectsRoot, "~/Projects"));
  const reposRaw = asObject(o.repos, "repos");
  const repos: Record<string, RepoConfig> = {};
  for (const [name, rc] of Object.entries(reposRaw)) repos[name] = parseRepo(name, rc, projectsRoot);
  if (Object.keys(repos).length === 0) throw new Error("config: no repos defined");
  return {
    concurrency: Math.max(1, numOr(o.concurrency, 1)),
    pollIntervalSec: Math.max(5, numOr(o.pollIntervalSec, 45)),
    workRoot: resolveHome(strOr(o.workRoot, "~/.cardwright/worktrees")),
    projectsRoot,
    telegramChatId: str(o.telegramChatId, "telegramChatId"),
    repos,
  };
}

export function loadConfig(path = "cardwright.config.json"): Config {
  if (!existsSync(path)) throw new Error(`config file not found: ${path} (run \`npm run setup\` first)`);
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function loadSecrets(envPath = ".env"): Secrets {
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const need = (k: string): string => {
    const v = process.env[k]?.trim();
    if (!v) throw new Error(`missing ${k} in environment (.env)`);
    return v;
  };
  return {
    trelloKey: need("TRELLO_API_KEY"),
    trelloToken: need("TRELLO_TOKEN"),
    telegramToken: need("TELEGRAM_BOT_TOKEN"),
    telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() || "",
    anthropicKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
  };
}
