import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "./redact.ts";

test("masks credential-shaped patterns", () => {
  const samples = [
    "key=sk-ant-api03-AbCdEf012345_- done",
    "token ghp_0123456789abcdefghijklmnopqrstuvwxyz x",
    "aws AKIAIOSFODNN7EXAMPLE here",
    "tg 123456789:AAH1aBcDeFgHiJkLmNoPqRsTuVwXyZ012345 end",
    "stripe sk_live_0123456789abcdefABCD x",
  ];
  for (const s of samples) {
    const out = redactSecrets(s);
    assert.equal(out.includes("[redacted]"), true, `should mask: ${s}`);
    assert.equal(/sk-ant-|ghp_|AKIA[0-9A-Z]|:AAH|sk_live_/.test(out), false, `secret leaked: ${out}`);
  }
});

test("masks a PEM private key block", () => {
  const pem = "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc123\n-----END RSA PRIVATE KEY-----\nafter";
  const out = redactSecrets(pem);
  assert.equal(out.includes("MIIabc123"), false);
  assert.equal(out, "before\n[redacted]\nafter");
});

test("masks explicit known secret values (>=8 chars), ignores short ones", () => {
  const out = redactSecrets("trello tok=abcdef1234567890 and short=abc", ["abcdef1234567890", "abc"]);
  assert.equal(out.includes("abcdef1234567890"), false, "long value masked");
  assert.equal(out.includes("abc"), true, "short value (<8) left intact");
});

test("leaves ordinary text untouched", () => {
  const s = "Implemented the date-planning flow; 3 tests added; PR opened.";
  assert.equal(redactSecrets(s), s);
});

test("handles empty input", () => {
  assert.equal(redactSecrets(""), "");
});
