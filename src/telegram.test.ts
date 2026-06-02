import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, chunkText } from "./telegram.ts";

test("escapeHtml escapes only & < >", () => {
  assert.equal(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  assert.equal(escapeHtml("plain text"), "plain text");
  assert.equal(escapeHtml("<b>not a tag from data</b>"), "&lt;b&gt;not a tag from data&lt;/b&gt;");
});

test("chunkText returns the whole string when short", () => {
  assert.deepEqual(chunkText("hello", 4096), ["hello"]);
});

test("chunkText splits on newline boundaries near the limit", () => {
  const text = "aaaa\nbbbb\ncccc";
  const parts = chunkText(text, 6); // forces splitting
  assert.ok(parts.every((p) => p.length <= 6));
  assert.equal(parts.join("\n"), text); // reconstructs losslessly on newline cuts
});

test("chunkText hard-cuts when there is no newline near the limit", () => {
  const text = "x".repeat(20);
  const parts = chunkText(text, 7);
  assert.ok(parts.every((p) => p.length <= 7));
  assert.equal(parts.join(""), text);
});
