import type { App } from "@modelcontextprotocol/ext-apps";
import { store } from "./state.js";
import type {
  Entity,
  ErrorCode,
  GraphSnapshot,
  MutationResult,
  Relation,
} from "./types.js";

type SuccessPayload = {
  ok: true;
  version: number;
  entity?: Entity;
  relation?: Relation;
  deletedRelations?: number;
};

type ErrorPayload = {
  ok: false;
  code: ErrorCode;
  message: string;
  currentVersion?: number;
};

type ToolPayload = SuccessPayload | ErrorPayload;

/**
 * The backend this iframe is currently rendering. Server-side v2.5 accepts a
 * `backend` arg on every tool to pick the JSONL file per call. Without this
 * helper, polling/mutation calls from the iframe would silently revert to the
 * server's boot-time default backend, causing the displayed graph to flip to
 * a different file 5s after open.
 *
 * Returns undefined when the store still has the placeholder ("(uninitialized)")
 * — in that window the iframe hasn't received a snapshot yet, so let the
 * server use its boot-time default to avoid forcing the wrong backend.
 */
function currentBackend(): string | undefined {
  const b = store.getSnapshot().backend;
  if (!b || b.label === "(uninitialized)") return undefined;
  return b.kind;
}

async function callTool<T extends ToolPayload>(
  app: App,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  // Inject the current backend kind as a default; explicit `args.backend`
  // (rare; only set when caller really wants to retarget) wins.
  const merged = { backend: currentBackend(), ...args };
  const result = await app.callServerTool({ name, arguments: merged });
  const sc = (result as { structuredContent?: unknown }).structuredContent;
  if (sc && typeof sc === "object") {
    return sc as T;
  }
  // Fallback — try to parse text content as JSON
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text;
  if (text) {
    try {
      return JSON.parse(text) as T;
    } catch {
      // fall through
    }
  }
  return {
    ok: false,
    code: "IO_ERROR",
    message: "No structured response",
  } as T;
}

function unwrap<T>(payload: ToolPayload, extract: (p: SuccessPayload) => T): MutationResult<T> {
  if (payload.ok) {
    return { ok: true, version: payload.version, payload: extract(payload) };
  }
  return {
    ok: false,
    code: payload.code,
    message: payload.message,
    currentVersion: payload.currentVersion,
  };
}

export const ServerClient = {
  async reload(app: App): Promise<GraphSnapshot | null> {
    // Per-call backend injection: without it, 5s polling reverts the iframe
    // to the server's boot-time default backend.
    const result = await app.callServerTool({
      name: "reload_graph",
      arguments: { backend: currentBackend() },
    });
    const sc = (result as { structuredContent?: unknown }).structuredContent;
    if (sc && typeof sc === "object" && "entities" in sc) {
      return sc as GraphSnapshot;
    }
    return null;
  },

  async createEntity(
    app: App,
    args: { name: string; entityType: string; observations: string[]; expectedVersion: number }
  ): Promise<MutationResult<Entity>> {
    const payload = await callTool<ToolPayload>(app, "create_entity", args);
    return unwrap(payload, (p) => p.entity!);
  },

  async updateEntity(
    app: App,
    args: {
      name: string;
      newName?: string;
      entityType?: string;
      observations?: string[];
      expectedVersion: number;
    }
  ): Promise<MutationResult<Entity>> {
    const payload = await callTool<ToolPayload>(app, "update_entity", args);
    return unwrap(payload, (p) => p.entity!);
  },

  async deleteEntity(
    app: App,
    args: { name: string; expectedVersion: number }
  ): Promise<MutationResult<{ deletedRelations: number }>> {
    const payload = await callTool<ToolPayload>(app, "delete_entity", args);
    return unwrap(payload, (p) => ({
      deletedRelations: p.deletedRelations ?? 0,
    }));
  },

  async addObservations(
    app: App,
    args: { name: string; contents: string[]; expectedVersion: number }
  ): Promise<MutationResult<Entity>> {
    const payload = await callTool<ToolPayload>(app, "add_observations", args);
    return unwrap(payload, (p) => p.entity!);
  },

  async deleteObservations(
    app: App,
    args: { name: string; contents: string[]; expectedVersion: number }
  ): Promise<MutationResult<Entity>> {
    const payload = await callTool<ToolPayload>(app, "delete_observations", args);
    return unwrap(payload, (p) => p.entity!);
  },

  async createRelation(
    app: App,
    args: { from: string; to: string; relationType: string; expectedVersion: number }
  ): Promise<MutationResult<Relation>> {
    const payload = await callTool<ToolPayload>(app, "create_relation", args);
    return unwrap(payload, (p) => p.relation!);
  },

  async deleteRelation(
    app: App,
    args: { from: string; to: string; relationType: string; expectedVersion: number }
  ): Promise<MutationResult<null>> {
    const payload = await callTool<ToolPayload>(app, "delete_relation", args);
    return unwrap(payload, () => null);
  },
};
