import test from "node:test";
import assert from "node:assert/strict";
import { run, ok, scopedEnv } from "./exec.ts";

test("captures stdout and a 0 exit code", async () => {
  const r = await run("node", ["-e", "process.stdout.write('hi')"]);
  assert.equal(r.stdout, "hi");
  assert.equal(r.code, 0);
  assert.ok(ok(r));
});

test("reports a nonzero exit code", async () => {
  const r = await run("node", ["-e", "process.exit(3)"]);
  assert.equal(r.code, 3);
  assert.equal(ok(r), false);
});

test("feeds stdin to the child", async () => {
  const r = await run(
    "node",
    ["-e", "let d='';process.stdin.on('data',x=>d+=x);process.stdin.on('end',()=>process.stdout.write(d.toUpperCase()))"],
    { input: "abc" },
  );
  assert.equal(r.stdout, "ABC");
});

test("times out and kills the process group quickly", async () => {
  const start = Date.now();
  const r = await run("node", ["-e", "setTimeout(()=>{}, 10000)"], { timeoutMs: 200 });
  const elapsed = Date.now() - start;
  assert.equal(r.timedOut, true);
  assert.equal(ok(r), false);
  assert.ok(elapsed < 3000, `expected a fast kill, took ${elapsed}ms`);
});

test("surfaces a spawn error for a missing binary", async () => {
  const r = await run("this-binary-does-not-exist-xyz", []);
  assert.equal(r.code, null);
  assert.match(r.stderr, /spawn error/);
});

test("missing binary with stdin input still resolves with a spawn error (no crash)", async () => {
  const r = await run("this-binary-does-not-exist-xyz", [], { input: "abc" });
  assert.equal(r.code, null);
  assert.match(r.stderr, /spawn error/);
});

test("maxBuffer caps captured output and marks the truncation", async () => {
  const r = await run("node", ["-e", "process.stdout.write('x'.repeat(100000))"], { maxBuffer: 1000 });
  assert.ok(r.stdout.length <= 1000 + 20, `stdout kept ${r.stdout.length} chars`);
  assert.match(r.stdout, /\[truncated\]/);
});

test("onLine emits one complete line at a time, joins across chunks, flushes the tail", async () => {
  const lines: string[] = [];
  // two writes: 'a\\nb' then 'c\\nd' → lines a, bc (joined across the chunk boundary), d (flushed)
  const r = await run(
    "node",
    ["-e", "process.stdout.write('a\\nb'); setTimeout(() => process.stdout.write('c\\nd'), 50)"],
    { onLine: (l, s) => { if (s === "stdout") lines.push(l); } },
  );
  assert.equal(r.code, 0);
  assert.deepEqual(lines, ["a", "bc", "d"]);
});

test("scopedEnv keeps the safe base, drops app secrets, includes granted extras", () => {
  process.env.TWR_TEST_SECRET = "super-secret-token";
  try {
    const env = scopedEnv({ ANTHROPIC_API_KEY: "ak-test", MISSING: undefined });
    assert.equal(env.TWR_TEST_SECRET, undefined, "non-allowlisted vars must be dropped");
    assert.equal(env.ANTHROPIC_API_KEY, "ak-test", "granted extras pass through");
    assert.equal("MISSING" in env, false, "undefined extras are skipped");
    if (process.env.PATH) assert.equal(env.PATH, process.env.PATH, "PATH (base) is preserved");
  } finally {
    delete process.env.TWR_TEST_SECRET;
  }
});

test("scopedEnv does not pass NODE_PATH (module-injection surface)", () => {
  const prev = process.env.NODE_PATH;
  process.env.NODE_PATH = "/tmp/evil-modules";
  try {
    assert.equal(scopedEnv().NODE_PATH, undefined);
  } finally {
    if (prev === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = prev;
  }
});

test("a child spawned with scopedEnv cannot read a non-allowlisted secret", async () => {
  process.env.TWR_TEST_SECRET = "leak-me";
  try {
    const r = await run("node", ["-e", "process.stdout.write(String(process.env.TWR_TEST_SECRET ?? 'ABSENT'))"], {
      env: scopedEnv(),
    });
    assert.equal(r.stdout, "ABSENT");
  } finally {
    delete process.env.TWR_TEST_SECRET;
  }
});
