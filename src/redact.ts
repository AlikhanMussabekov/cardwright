/**
 * Defense-in-depth redaction for text bound for a semi-public sink — GitHub PR bodies,
 * Trello card comments, Telegram messages. Worker output and failed-command tails are
 * untrusted; if a credential ever surfaces in them it must not leave the daemon verbatim.
 *
 * Two layers: (1) exact known secret VALUES the daemon holds (Trello/Telegram/Anthropic),
 * and (2) generic credential-shaped patterns. Pure + unit-tested.
 */

const MASK = "[redacted]";

// High-confidence credential shapes (kept deliberately specific to avoid masking prose).
const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, // OpenAI
  /sk_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bgh[posru]_[A-Za-z0-9]{36}\b/g, // GitHub PAT / OAuth / server / user / refresh
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\b\d{8,10}:[A-Za-z0-9_-]{35,}\b/g, // Telegram bot token
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
];

/**
 * Redact credentials from `text`. `values` are exact secret strings the caller knows
 * (e.g. the daemon's loaded tokens) and are masked first; then generic patterns run.
 * Short/empty values are ignored so we never mask trivial substrings.
 */
export function redactSecrets(text: string, values: string[] = []): string {
  if (!text) return text;
  let out = text;
  for (const v of values) {
    if (v && v.length >= 8) out = out.split(v).join(MASK);
  }
  for (const re of PATTERNS) out = out.replace(re, MASK);
  return out;
}
