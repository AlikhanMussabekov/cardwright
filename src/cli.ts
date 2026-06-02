#!/usr/bin/env node
/**
 * cardwright CLI entry. Dispatches `setup` / `daemon [--once]` / `--help` / `--version`.
 *
 * Design notes (locked in the 2026-06-02 eng review):
 *  - The Node-version guard runs BEFORE importing any subcommand module, so a user on
 *    Node < 24 gets a friendly message instead of an opaque `node:sqlite`
 *    ERR_UNKNOWN_BUILTIN_MODULE thrown from a hoisted import.
 *  - Subcommand modules are loaded LAZILY (dynamic import), so `--help`/`--version`
 *    never load `node:sqlite` and never emit its ExperimentalWarning. The published
 *    bin runs via a plain `#!/usr/bin/env node` shebang that cannot pass
 *    `--disable-warning`, so we keep the experimental module off the cheap paths.
 *  - `route()` is pure and exported for unit tests. The dispatch only auto-runs when
 *    this file is the process entry point (see `isMain`), so importing it from a test
 *    is side-effect-free.
 */
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

export type Action =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "setup" }
  | { kind: "daemon"; once: boolean }
  | { kind: "unknown"; cmd: string };

/** Pure argv → action mapping. `argv` is `process.argv.slice(2)`. */
export function route(argv: string[]): Action {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "-h" || cmd === "--help") return { kind: "help" };
  if (cmd === "-v" || cmd === "--version") return { kind: "version" };
  if (cmd === "setup") return { kind: "setup" };
  if (cmd === "daemon") return { kind: "daemon", once: argv.slice(1).includes("--once") };
  return { kind: "unknown", cmd };
}

const USAGE = `cardwright — Trello-driven autonomous Claude Code pipeline

Usage:
  cardwright setup            One-time onboarding (verify Trello/Telegram, write config)
  cardwright daemon [--once]  Run the poll → work → PR loop  (--once = a single cycle)
  cardwright --version        Print the version
  cardwright --help           Show this help
`;

/** Read the version from package.json, resolved relative to this (compiled) file. */
export async function readVersion(): Promise<string> {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
}

function assertNode(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major < 24) {
    console.error(
      `cardwright requires Node >= 24 (you have v${process.versions.node}). ` +
        "It uses node:sqlite, which is unavailable on older Node.",
    );
    process.exit(1);
  }
}

export async function dispatch(argv: string[]): Promise<void> {
  const action = route(argv);
  switch (action.kind) {
    case "help":
      console.log(USAGE);
      return;
    case "version":
      console.log(await readVersion());
      return;
    case "setup": {
      const { main } = await import("./setup.ts");
      await main();
      return;
    }
    case "daemon": {
      const { main } = await import("./daemon.ts");
      await main({ once: action.once });
      return;
    }
    case "unknown":
      console.error(`unknown command: ${action.cmd}\n`);
      console.error(USAGE);
      process.exit(1);
  }
}

/** True only when this file is the process entry point (not imported as a module). */
function isMain(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  assertNode();
  dispatch(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
