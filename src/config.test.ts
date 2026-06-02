import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { parseConfig, resolveHome } from "./config.ts";

function validRaw(): any {
  return {
    concurrency: 2,
    pollIntervalSec: 30,
    workRoot: "~/wt",
    telegramChatId: "-123",
    repos: {
      "org/repo": {
        repoPath: "/x",
        testCmd: "bun run test",
        board: {
          boardId: "b",
          lists: { ready: "r", inProgress: "i", review: "v", done: "d", needsHuman: "n" },
          processedLabelId: "L",
        },
      },
    },
  };
}

test("parses a valid config and applies sensible defaults", () => {
  const c = parseConfig(validRaw());
  assert.equal(c.concurrency, 2);
  assert.equal(c.telegramChatId, "-123");
  const r = c.repos["org/repo"]!;
  assert.equal(r.defaultBranch, "main");
  assert.equal(r.deployMode, "pr-only");
  assert.equal(r.autoMerge, false);
  assert.deepEqual(r.allowedPaths, ["**"]);
  assert.equal(r.maxBudgetUsd, 15);
  assert.equal(r.maxFixAttempts, 5);
  assert.equal(r.board.lists.review, "v");
});

test("throws on missing telegramChatId", () => {
  const raw = validRaw();
  delete raw.telegramChatId;
  assert.throws(() => parseConfig(raw), /telegramChatId/);
});

test("throws when a board list key is missing", () => {
  const raw = validRaw();
  delete raw.repos["org/repo"].board.lists.review;
  assert.throws(() => parseConfig(raw), /lists\.review/);
});

test("throws when there are no repos", () => {
  assert.throws(() => parseConfig({ telegramChatId: "x", repos: {} }), /no repos/);
});

test("throws on an invalid deployMode", () => {
  const raw = validRaw();
  raw.repos["org/repo"].deployMode = "yolo";
  assert.throws(() => parseConfig(raw), /deployMode/);
});

test("auto-merge requires branch protection + required checks (earned gate)", () => {
  const raw = validRaw();
  raw.repos["org/repo"].autoMerge = true;
  assert.throws(() => parseConfig(raw), /autoMerge requires/);
  raw.repos["org/repo"].protectedBranch = true;
  raw.repos["org/repo"].requiredChecks = ["ci/test"];
  assert.equal(parseConfig(raw).repos["org/repo"]!.autoMerge, true);
});

test("repoPath is derived from projectsRoot + key when omitted", () => {
  const raw = validRaw();
  raw.projectsRoot = "/work";
  delete raw.repos["org/repo"].repoPath;
  const c = parseConfig(raw);
  assert.equal(c.projectsRoot, "/work");
  assert.equal(c.repos["org/repo"]!.repoPath, "/work/org/repo");
});

test("projectsRoot defaults to ~/Projects", () => {
  assert.equal(parseConfig(validRaw()).projectsRoot, `${homedir()}/Projects`);
});

test("resolveHome expands a leading ~", () => {
  assert.equal(resolveHome("~"), homedir());
  assert.equal(resolveHome("~/x/y"), `${homedir()}/x/y`);
  assert.equal(resolveHome("/abs"), "/abs");
});
