import type { App } from "@modelcontextprotocol/ext-apps";
import { store } from "./state.js";

/**
 * Silent push of UI-originated changes into the LLM's context. The host shows
 * nothing to the user; the LLM sees the new info in the next turn.
 *
 * The MCP UI host keeps only the *last* updateModelContext call per the spec
 * (app.d.ts: "Only the last update is sent; each call overwrites any previous
 * context."). Without batching, a sequence of UI mutations would result in the
 * LLM seeing only the most recent one. We work around this with a ring buffer:
 * every call re-sends the cumulative recent history plus current snapshot meta,
 * so the surviving last call always carries the full picture.
 */
let appRef: App | null = null;
let enabled = true;

const MAX_RECENT = 50;
interface RecentEvent {
  op: string;
  summary: string;
  detail: unknown;
  ts: string;
}
const recent: RecentEvent[] = [];

export function setApp(a: App): void {
  appRef = a;
}

export function setNotifyEnabled(v: boolean): void {
  enabled = v;
}

export function isNotifyEnabled(): boolean {
  return enabled;
}

export interface ChangeEvent {
  op: string;
  summary: string;
  detail?: Record<string, unknown> | object;
}

export function notifyChange(ev: ChangeEvent): void {
  if (!enabled || !appRef) return;

  recent.push({
    op: ev.op,
    summary: ev.summary,
    detail: ev.detail ?? null,
    ts: new Date().toISOString(),
  });
  if (recent.length > MAX_RECENT) recent.shift();

  // Read live counts from the store's internal maps. `getSnapshot()` returns
  // the last server-pushed snapshot whose entities/relations arrays go stale
  // after local apply* mutations — only `version` is kept in sync via setVersion.
  const version = store.getSnapshot().version;
  const nodeCount = store.getEntities().length;
  const relCount = store.getRelations().length;

  const header = `Graph-view state (v${version}, ${nodeCount} nodes, ${relCount} relations)`;
  const log = recent.map((c) => `- [${c.op}] ${c.summary}`).join("\n");
  const text =
    `${header}\nRecent UI events (oldest first, ${recent.length} of last ${MAX_RECENT}):\n${log}`;

  appRef
    .updateModelContext({
      content: [{ type: "text" as const, text }],
      structuredContent: {
        type: "graph_view_state",
        version,
        counts: { nodes: nodeCount, relations: relCount },
        source: "graph-view-ui",
        changes: recent.map((c) => ({
          op: c.op,
          summary: c.summary,
          timestamp: c.ts,
          detail: c.detail,
        })),
      } as Record<string, unknown>,
    })
    .catch((err) => {
      console.warn("[graph-view] updateModelContext failed:", err);
    });
}

/**
 * Send a user-visible chat message asking the LLM to perform some task.
 * Used by the orphan-cleanup wizard.
 *
 * The MCP UI spec requires `role: "user"` and rejects messages without it.
 * Errors are surfaced via the returned MutationOutcome instead of swallowed.
 */
export interface SendOutcome {
  ok: boolean;
  error?: string;
}

export async function sendChatRequest(prompt: string): Promise<SendOutcome> {
  if (!appRef) return { ok: false, error: "App not initialized" };
  try {
    const result = await appRef.sendMessage({
      role: "user",
      content: [{ type: "text" as const, text: prompt }],
    });
    if ((result as { isError?: boolean }).isError) {
      console.warn("[graph-view] sendMessage rejected by host:", result);
      return { ok: false, error: "Host rejected the message" };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[graph-view] sendMessage failed:", err);
    return { ok: false, error: msg };
  }
}
