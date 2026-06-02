import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { route, readVersion } from "./cli.ts";

// ── T1 (regression guard) ────────────────────────────────────────────────────
// cli.ts imports setup/daemon LAZILY and only runs main() on explicit dispatch.
// The whole CLI design depends on importing those modules being side-effect-free.
// Before the export-main refactor, importing setup.ts ran the FULL live onboarding
// (real Trello call, Telegram ping, config overwrite). A reintroduced top-level
// call would fire that on any `cardwright --version`. This locks the contract:
// importing performs ZERO network calls and exposes main() as a function.
test("importing setup/daemon is side-effect-free (no network on import)", async () => {
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof realFetch>) => {
    fetchCalls++;
    return realFetch(...args);
  }) as typeof fetch;
  try {
    const setup = await import("./setup.ts");
    const daemon = await import("./daemon.ts");
    assert.equal(typeof setup.main, "function", "setup must export main()");
    assert.equal(typeof daemon.main, "function", "daemon must export main()");
    assert.equal(fetchCalls, 0, "importing setup/daemon must not perform any network call");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── T2 (route dispatch) ──────────────────────────────────────────────────────
test("route: help on no args / -h / --help", () => {
  assert.deepEqual(route([]), { kind: "help" });
  assert.deepEqual(route(["-h"]), { kind: "help" });
  assert.deepEqual(route(["--help"]), { kind: "help" });
});

test("route: version on -v / --version", () => {
  assert.deepEqual(route(["--version"]), { kind: "version" });
  assert.deepEqual(route(["-v"]), { kind: "version" });
});

test("route: setup", () => {
  assert.deepEqual(route(["setup"]), { kind: "setup" });
});

test("route: daemon forwards --once", () => {
  assert.deepEqual(route(["daemon"]), { kind: "daemon", once: false });
  assert.deepEqual(route(["daemon", "--once"]), { kind: "daemon", once: true });
});

test("route: unknown command", () => {
  assert.deepEqual(route(["bogus"]), { kind: "unknown", cmd: "bogus" });
});

// Version must come from package.json (no hardcoded literal that can drift).
test("readVersion equals package.json version", async () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal(await readVersion(), pkg.version);
});
