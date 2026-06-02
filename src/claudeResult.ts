/**
 * Parser for the `claude -p --output-format json` output.
 *
 * VERIFIED on claude 2.1.159: `--output-format json` prints a JSON ARRAY of
 * stream events (e.g. system/init, assistant, rate_limit_event, result), NOT a
 * single object. The final `type:"result"` element carries the fields we need.
 * The daemon must never trust the agent's prose self-report; it reads these
 * structured fields and independently re-verifies outcomes elsewhere.
 */

export interface ClaudeResult {
  /** The agent's final message text (advisory only — never a control signal). */
  result: string;
  sessionId: string;
  totalCostUsd: number;
  isError: boolean;
  /** e.g. "success", "error_max_budget", "error_during_execution". */
  subtype: string;
  numTurns: number;
  stopReason?: string;
  terminalReason?: string;
  permissionDenials: unknown[];
}

/** True when the run hit the native `--max-budget-usd` ceiling. */
export function isBudgetExceeded(r: ClaudeResult): boolean {
  return r.subtype.includes("budget") || r.terminalReason === "budget_exceeded";
}

/**
 * Parse raw stdout from `claude -p --output-format json` into a ClaudeResult.
 * Throws on empty output, invalid JSON, or a missing result event — all of
 * which the daemon treats as a hard failure (fail closed), not a pass.
 */
/** Map the final `type:"result"` event (scanning from the end) to a ClaudeResult. */
function resultFromEvents(events: unknown[]): ClaudeResult {
  const resultEvent = [...events]
    .reverse()
    .find(
      (e): e is Record<string, unknown> =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>).type === "result",
    );

  if (!resultEvent) {
    throw new Error("claude output contained no result event");
  }

  return {
    result: typeof resultEvent.result === "string" ? resultEvent.result : "",
    sessionId: typeof resultEvent.session_id === "string" ? resultEvent.session_id : "",
    totalCostUsd:
      typeof resultEvent.total_cost_usd === "number" ? resultEvent.total_cost_usd : 0,
    isError: resultEvent.is_error === true,
    subtype: typeof resultEvent.subtype === "string" ? resultEvent.subtype : "",
    numTurns: typeof resultEvent.num_turns === "number" ? resultEvent.num_turns : 0,
    stopReason:
      typeof resultEvent.stop_reason === "string" ? resultEvent.stop_reason : undefined,
    terminalReason:
      typeof resultEvent.terminal_reason === "string"
        ? resultEvent.terminal_reason
        : undefined,
    permissionDenials: Array.isArray(resultEvent.permission_denials)
      ? resultEvent.permission_denials
      : [],
  };
}

/** Parse `--output-format json` — a JSON array of events (or a lone object). */
export function parseClaudeJsonOutput(raw: string): ClaudeResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("claude produced no output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`claude output was not valid JSON: ${(err as Error).message}`);
  }
  return resultFromEvents(Array.isArray(parsed) ? parsed : [parsed]);
}

/** Parse `--output-format stream-json` — NDJSON, one event per line. */
export function parseClaudeStream(raw: string): ClaudeResult {
  if (!raw.trim()) {
    throw new Error("claude produced no output");
  }
  const events: unknown[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      events.push(JSON.parse(s));
    } catch {
      // ignore non-JSON noise lines
    }
  }
  return resultFromEvents(events);
}
