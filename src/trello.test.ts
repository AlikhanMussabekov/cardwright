import test from "node:test";
import assert from "node:assert/strict";
import {
  extractReadyCardEvents,
  cardContentHash,
  hasProcessedLabel,
  acceptanceCriteria,
  maxActionId,
  imageAttachments,
  isTrelloCredentialHost,
  retryAfterSeconds,
  type TrelloAction,
  type TrelloCard,
  type TrelloAttachment,
} from "./trello.ts";

const READY = "readyList";

test("extractReadyCardEvents catches creates-into-ready and moves-into-ready only", () => {
  const actions: TrelloAction[] = [
    { id: "a1", type: "createCard", data: { card: { id: "c1" }, list: { id: READY } } },
    { id: "a2", type: "createCard", data: { card: { id: "c2" }, list: { id: "other" } } },
    { id: "a3", type: "updateCard", data: { card: { id: "c3" }, listAfter: { id: READY }, listBefore: { id: "inbox" } } },
    { id: "a4", type: "updateCard", data: { card: { id: "c4" }, listAfter: { id: "done" } } },
    { id: "a5", type: "commentCard", data: { card: { id: "c5" } } },
  ];
  assert.deepEqual(extractReadyCardEvents(actions, READY), [
    { cardId: "c1", actionId: "a1" },
    { cardId: "c3", actionId: "a3" },
  ]);
});

test("cardContentHash is stable under whitespace and changes on real edits", () => {
  const base: TrelloCard = {
    id: "c",
    name: "Build X",
    desc: "do it",
    idList: "l",
    labels: [],
    checklists: [{ name: "AC", checkItems: [{ name: "works", state: "incomplete" }] }],
  };
  assert.equal(cardContentHash(base), cardContentHash({ ...base, name: "  Build X  " }));
  assert.notEqual(cardContentHash(base), cardContentHash({ ...base, desc: "do it differently" }));
  assert.notEqual(
    cardContentHash(base),
    cardContentHash({
      ...base,
      checklists: [{ name: "AC", checkItems: [{ name: "works", state: "incomplete" }, { name: "and more", state: "incomplete" }] }],
    }),
  );
});

test("acceptanceCriteria flattens all checklist items in order", () => {
  const card: TrelloCard = {
    id: "c",
    name: "x",
    desc: "",
    idList: "l",
    labels: [],
    checklists: [
      { name: "AC", checkItems: [{ name: "a", state: "incomplete" }, { name: "b", state: "complete" }] },
      { name: "More", checkItems: [{ name: "c", state: "incomplete" }] },
    ],
  };
  assert.deepEqual(acceptanceCriteria(card), ["a", "b", "c"]);
});

test("hasProcessedLabel detects the marker label by id", () => {
  const card: TrelloCard = { id: "c", name: "x", desc: "", idList: "l", labels: [{ id: "L1", name: "processed" }] };
  assert.equal(hasProcessedLabel(card, "L1"), true);
  assert.equal(hasProcessedLabel(card, "L2"), false);
});

test("imageAttachments keeps only Trello-hosted image UPLOADS (drops linked URLs)", () => {
  const atts: TrelloAttachment[] = [
    { id: "1", name: "a.png", mimeType: "image/png", url: "u1", bytes: 1, isUpload: true },
    { id: "2", name: "doc.pdf", mimeType: "application/pdf", url: "u2", bytes: 1, isUpload: true },
    { id: "3", name: "b.jpeg", mimeType: "image/jpeg", url: "u3", bytes: 1, isUpload: true },
    { id: "4", name: "link", mimeType: "", url: "u4", bytes: 0, isUpload: false },
    // SECURITY: a LINKED image (attacker-controlled URL) must be dropped even though
    // its mimeType is image/* — otherwise downloadAttachment would leak credentials.
    { id: "5", name: "evil.png", mimeType: "image/png", url: "https://attacker.com/x.png", bytes: 1, isUpload: false },
  ];
  assert.deepEqual(imageAttachments(atts).map((a) => a.name), ["a.png", "b.jpeg"]);
});

test("isTrelloCredentialHost allows only https Trello hosts", () => {
  assert.equal(isTrelloCredentialHost("https://api.trello.com/1/cards/x/attachments/y/download/z.png"), true);
  assert.equal(isTrelloCredentialHost("https://trello.com/1/cards/x"), true);
  assert.equal(isTrelloCredentialHost("https://cdn.trello.com/x.png"), true);
  // Off-host, private IP, non-https, and junk must all be rejected (fail closed).
  assert.equal(isTrelloCredentialHost("https://attacker.com/x.png"), false);
  assert.equal(isTrelloCredentialHost("https://trello.com.attacker.com/x"), false);
  assert.equal(isTrelloCredentialHost("http://api.trello.com/x"), false);
  assert.equal(isTrelloCredentialHost("https://127.0.0.1/x"), false);
  assert.equal(isTrelloCredentialHost("not a url"), false);
});

test("maxActionId returns the highest id or null", () => {
  assert.equal(
    maxActionId([
      { id: "a3", type: "x", data: {} },
      { id: "a5", type: "x", data: {} },
      { id: "a1", type: "x", data: {} },
    ]),
    "a5",
  );
  assert.equal(maxActionId([]), null);
});

test("retryAfterSeconds honors the header, clamps to >=1s, defaults to 2s", () => {
  assert.equal(retryAfterSeconds(null), 2); // header absent
  assert.equal(retryAfterSeconds(""), 2);
  assert.equal(retryAfterSeconds("5"), 5);
  assert.equal(retryAfterSeconds("0"), 1); // Retry-After: 0 must still back off
  assert.equal(retryAfterSeconds("Thu, 01 Jan 2026 00:00:00 GMT"), 2); // HTTP-date form → default
});
