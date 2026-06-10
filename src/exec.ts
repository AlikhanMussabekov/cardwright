/**
 * Subprocess runner used for every external command (claude, bun, git, gh, codex).
 *
 * Each child is spawned DETACHED (its own process group), and on timeout we kill
 * the entire group with `process.kill(-pid)` — so dev servers, test runners, and
 * other grandchildren a worker spawns are reaped, not orphaned. This is Codex's
 * "process-group spawn + full-tree kill on timeout" P1, made concrete.
 */

import { spawn } from "node:child_process";
import process from "node:process";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  /**
   * When set, REPLACES the child's environment entirely (it is NOT merged over
   * process.env) — so a scoped env actually withholds the parent's secrets. Build it
   * with scopedEnv() to start from a safe, secret-free base plus only what you grant.
   */
  env?: Record<string, string>;
  input?: string;
  /** Max bytes of stdout/stderr to retain (guards against runaway output). */
  maxBuffer?: number;
  /** Called once per complete output line (for live streaming). Full buffers are still captured. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const maxBuffer = opts.maxBuffer ?? 10 * 1024 * 1024; // 10 MB
  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env, // opts.env is authoritative (see RunOptions.env) — never silently merged with the parent's secrets
      detached: true, // new process group → killable as a unit
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // Per-stream partial-line buffers for the onLine callback.
    let outRem = "";
    let errRem = "";
    const emitLines = (chunk: string, stream: "stdout" | "stderr"): void => {
      if (!opts.onLine) return;
      const buf = (stream === "stdout" ? outRem : errRem) + chunk;
      const parts = buf.split("\n");
      const remainder = parts.pop() ?? "";
      if (stream === "stdout") outRem = remainder;
      else errRem = remainder;
      for (const line of parts) opts.onLine(line, stream);
    };

    const killTree = (): void => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, "SIGKILL"); // negative pid → whole group
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree();
        }, opts.timeoutMs)
      : null;

    // Append capped at maxBuffer exactly (never a whole runaway chunk past the limit),
    // with a one-time marker so truncation is visible downstream, not silent.
    const appendCapped = (cur: string, s: string): string => {
      if (cur.length >= maxBuffer) return cur;
      const rem = maxBuffer - cur.length;
      return rem >= s.length ? cur + s : cur + s.slice(0, rem) + "\n[truncated]";
    };

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout = appendCapped(stdout, s);
      emitLines(s, "stdout");
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr = appendCapped(stderr, s);
      emitLines(s, "stderr");
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (opts.onLine) {
        if (outRem) opts.onLine(outRem, "stdout");
        if (errRem) opts.onLine(errRem, "stderr");
      }
      resolve({ code, signal, stdout, stderr, timedOut });
    };

    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (err) => {
      stderr += `\n[spawn error] ${(err as Error).message}`;
      finish(null, null);
    });

    // A failed spawn (missing binary) destroys stdin; without a listener the queued
    // write's EPIPE becomes an uncaught exception. The spawn error itself still
    // surfaces via the child's 'error' handler above.
    child.stdin.on("error", () => {});
    if (opts.input != null) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** True when the process finished cleanly with exit code 0. */
export function ok(r: RunResult): boolean {
  return !r.timedOut && r.code === 0;
}

/**
 * Env vars safe to pass to UNTRUSTED-facing children (the worker, the target repo's
 * own build/test scripts, codex). Carries what tooling needs to run + authenticate via
 * the user's home dir (claude/codex/gh/git read ~/.claude, ~/.codex, ~/.config/gh,
 * ~/.gitconfig), but NONE of the daemon's app secrets.
 */
const SAFE_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "TMPDIR", "TEMP", "TMP", "TERM", "TZ", "COLUMNS", "LINES", "PWD",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "SSH_AUTH_SOCK",
];

/**
 * Minimal environment for an untrusted-facing subprocess: the safe base (above) plus
 * ONLY the extra keys explicitly granted. The daemon's own secrets (Trello/Telegram
 * tokens, and any key not in `extra`) are never inherited — so a prompt-injected worker
 * or a poisoned repo script cannot read them out of `process.env` and exfiltrate them.
 */
export function scopedEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) {
    const v = process.env[k];
    if (v != null) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v != null) out[k] = v;
  return out;
}
