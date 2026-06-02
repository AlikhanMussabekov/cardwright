/**
 * Minimal Telegram notifier (raw fetch, HTML mode).
 *
 * HTML parse mode needs only `& < >` escaped (far safer than MarkdownV2's 18-char
 * set for machine-generated text). Messages are chunked to the 4096-char limit on
 * newline boundaries. `escapeHtml`/`chunkText` are pure and unit-tested.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Split into <=max-char pieces, preferring newline boundaries. */
export function chunkText(text: string, max = 4096): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = max; // no newline near the limit → hard cut
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length) out.push(rest);
  return out;
}

export class TelegramClient {
  private readonly token: string;
  private readonly chatId: string;

  constructor(token: string, chatId: string) {
    this.token = token;
    this.chatId = chatId;
  }

  /** Send HTML-formatted text (already-escaped where needed), chunked + 429-retried. */
  async send(html: string): Promise<void> {
    for (const part of chunkText(html)) await this.post(part);
  }

  private async post(text: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (data.ok) return;
      if (res.status === 429 && data.parameters?.retry_after && attempt < 5) {
        await sleep((data.parameters.retry_after || 1) * 1000);
        continue;
      }
      throw new Error(`Telegram sendMessage failed: ${data.description ?? res.status}`);
    }
  }
}
