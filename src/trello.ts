/**
 * Trello REST client + pure detection helpers.
 *
 * Detection uses the board ACTIONS feed with a `since` action-id cursor (not the
 * noisy `dateLastActivity`), so each new/moved card is seen exactly once. Pure
 * helpers (`extractReadyCardEvents`, `cardContentHash`, ...) are unit-tested; the
 * HTTP methods are thin and live-validated against the real board.
 *
 * Rate limits: 100 req/10s per token. A small inter-request gate (~9 req/s) keeps
 * us well under, plus 429 backoff honoring Retry-After.
 */

import { createHash } from "node:crypto";

const TRELLO_API = "https://api.trello.com/1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TrelloAction {
  id: string;
  type: string;
  date?: string;
  data: {
    card?: { id: string; name?: string };
    list?: { id: string; name?: string };
    listAfter?: { id: string; name?: string };
    listBefore?: { id: string; name?: string };
    board?: { id: string };
  };
}

export interface TrelloLabel {
  id: string;
  name: string;
  color?: string;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  labels: TrelloLabel[];
  checklists?: { name: string; checkItems?: { name: string; state: string }[] }[];
}

export interface TrelloAttachment {
  id: string;
  name: string;
  mimeType: string;
  url: string;
  bytes: number;
  isUpload: boolean;
}

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────────

/** Cards that entered the "Ready for Agent" list, in feed order. */
export function extractReadyCardEvents(
  actions: TrelloAction[],
  readyListId: string,
): { cardId: string; actionId: string }[] {
  const out: { cardId: string; actionId: string }[] = [];
  for (const a of actions) {
    const cardId = a.data.card?.id;
    if (!cardId) continue;
    if (a.type === "createCard" && a.data.list?.id === readyListId) {
      out.push({ cardId, actionId: a.id });
    } else if (a.type === "updateCard" && a.data.listAfter?.id === readyListId) {
      out.push({ cardId, actionId: a.id });
    }
  }
  return out;
}

export function acceptanceCriteria(card: TrelloCard): string[] {
  const items: string[] = [];
  for (const cl of card.checklists ?? []) {
    for (const ci of cl.checkItems ?? []) items.push(ci.name);
  }
  return items;
}

/** Stable short hash of the card's actionable content; changes when the card is edited. */
export function cardContentHash(card: TrelloCard): string {
  const norm = JSON.stringify({
    name: card.name.trim(),
    desc: card.desc.trim(),
    ac: acceptanceCriteria(card),
  });
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

export function hasProcessedLabel(card: TrelloCard, labelId: string): boolean {
  return (card.labels ?? []).some((l) => l.id === labelId);
}

/**
 * Image attachments the worker should see — restricted to Trello-hosted UPLOADS.
 * A LINKED attachment (`isUpload:false`) carries an attacker-controlled URL, so it is
 * never fetched: doing so would leak our Trello credentials and is an SSRF vector
 * (see `downloadAttachment` + `isTrelloCredentialHost`).
 */
export function imageAttachments(atts: TrelloAttachment[]): TrelloAttachment[] {
  return atts.filter((a) => a.isUpload === true && (a.mimeType ?? "").startsWith("image/"));
}

/**
 * Hosts we will send the Trello OAuth credential to. Only api.trello.com / trello.com
 * (and trello.com subdomains). Anything else (a linked URL, a private IP, a CDN) must
 * NOT receive our key+token. Returns false on unparseable input — fail closed.
 */
export function isTrelloCredentialHost(url: string): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "trello.com" || host === "api.trello.com" || host.endsWith(".trello.com");
}

/** Highest action id across a feed (ids are lexicographically monotonic in Trello). */
export function maxActionId(actions: TrelloAction[]): string | null {
  let max: string | null = null;
  for (const a of actions) if (max === null || a.id > max) max = a.id;
  return max;
}

// ── HTTP client ────────────────────────────────────────────────────────────────

class RateGate {
  private last = 0;
  private readonly minIntervalMs: number;
  constructor(minIntervalMs: number) {
    this.minIntervalMs = minIntervalMs;
  }
  async wait(): Promise<void> {
    const delta = Date.now() - this.last;
    if (delta < this.minIntervalMs) await sleep(this.minIntervalMs - delta);
    this.last = Date.now();
  }
}

export class TrelloClient {
  private readonly gate = new RateGate(110); // ~9 req/s, well under 100/10s
  private readonly key: string;
  private readonly token: string;

  constructor(key: string, token: string) {
    this.key = key;
    this.token = token;
  }

  private async request(method: string, path: string, params: Record<string, string | undefined>): Promise<any> {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, key: this.key, token: this.token })) {
      if (v != null && v !== "") sp.set(k, v);
    }
    const url = `${TRELLO_API}${path}?${sp.toString()}`;
    for (let attempt = 0; ; attempt++) {
      await this.gate.wait();
      const res = await fetch(url, { method });
      if (res.status === 429) {
        if (attempt >= 5) throw new Error(`Trello ${method} ${path} rate-limited after ${attempt} retries`);
        const ra = Number(res.headers.get("retry-after") || "2");
        await sleep((Number.isFinite(ra) ? ra : 2) * 1000);
        continue;
      }
      const body = await res.text();
      if (!res.ok) throw new Error(`Trello ${method} ${path} → ${res.status}: ${body.slice(0, 300)}`);
      return body ? JSON.parse(body) : null;
    }
  }

  getMe(): Promise<{ id: string; username: string; fullName: string }> {
    return this.request("GET", "/members/me", { fields: "id,username,fullName" });
  }

  getBoard(boardId: string): Promise<{ id: string; name: string }> {
    return this.request("GET", `/boards/${boardId}`, { fields: "id,name" });
  }

  getLists(boardId: string): Promise<{ id: string; name: string }[]> {
    return this.request("GET", `/boards/${boardId}/lists`, { fields: "id,name" });
  }

  getCardsInList(listId: string): Promise<{ id: string; name: string }[]> {
    return this.request("GET", `/lists/${listId}/cards`, { fields: "id,name" });
  }

  async getCard(cardId: string): Promise<TrelloCard> {
    const c = await this.request("GET", `/cards/${cardId}`, {
      fields: "name,desc,idList,labels",
      checklists: "all",
      checkItem_fields: "name,state",
    });
    return {
      id: c.id,
      name: c.name ?? "",
      desc: c.desc ?? "",
      idList: c.idList ?? "",
      labels: Array.isArray(c.labels) ? c.labels : [],
      checklists: Array.isArray(c.checklists) ? c.checklists : [],
    };
  }

  /** Latest action id on the board — used to seed the cursor on first run. */
  async latestActionId(boardId: string, filter = "createCard,updateCard"): Promise<string | null> {
    const page: TrelloAction[] = await this.request("GET", `/boards/${boardId}/actions`, {
      filter,
      limit: "1",
    });
    return Array.isArray(page) && page[0] ? page[0].id : null;
  }

  /**
   * All actions newer than `since` (an action id), in chronological order.
   * Paginates backward with `before` so no actions are skipped between polls.
   */
  async actionsSince(
    boardId: string,
    since: string,
    filter = "createCard,updateCard",
  ): Promise<TrelloAction[]> {
    const limit = 1000;
    const collected: TrelloAction[] = [];
    let before: string | undefined;
    for (;;) {
      const page: TrelloAction[] = await this.request("GET", `/boards/${boardId}/actions`, {
        filter,
        since,
        before,
        limit: String(limit),
      });
      if (!Array.isArray(page) || page.length === 0) break;
      collected.push(...page);
      if (page.length < limit) break;
      before = page[page.length - 1]!.id; // oldest in page → page older next, still bounded by `since`
    }
    return collected.reverse(); // newest-first → chronological
  }

  moveCard(cardId: string, listId: string): Promise<unknown> {
    return this.request("PUT", `/cards/${cardId}`, { idList: listId, pos: "top" });
  }

  commentCard(cardId: string, text: string): Promise<unknown> {
    return this.request("POST", `/cards/${cardId}/actions/comments`, { text });
  }

  attachUrl(cardId: string, url: string, name: string): Promise<unknown> {
    return this.request("POST", `/cards/${cardId}/attachments`, { url, name });
  }

  addLabel(cardId: string, labelId: string): Promise<unknown> {
    return this.request("POST", `/cards/${cardId}/idLabels`, { value: labelId });
  }

  getAttachments(cardId: string): Promise<TrelloAttachment[]> {
    return this.request("GET", `/cards/${cardId}/attachments`, {
      fields: "id,name,mimeType,url,bytes,isUpload",
    });
  }

  /**
   * Download an uploaded attachment. The Trello OAuth credential is sent ONLY to
   * Trello-owned hosts — never to an arbitrary/linked URL (which would exfiltrate the
   * key+token). Callers should pass only `isUpload` attachments (see imageAttachments).
   */
  async downloadAttachment(url: string): Promise<Uint8Array> {
    if (!isTrelloCredentialHost(url)) {
      throw new Error(`refusing to download non-Trello attachment URL (host not allowed): ${url.slice(0, 80)}`);
    }
    await this.gate.wait();
    const res = await fetch(url, {
      headers: { Authorization: `OAuth oauth_consumer_key="${this.key}", oauth_token="${this.token}"` },
    });
    if (!res.ok) throw new Error(`Trello download ${res.status} for ${url.slice(0, 80)}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
