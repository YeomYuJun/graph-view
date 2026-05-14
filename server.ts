#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  IoError,
  backupOnStart,
  resolveBackend,
} from "./server/memory-io.js";
import { AnthropicFileBackend } from "./server/backends/anthropic-file.js";
import { RemoteMemoryMirrorBackend } from "./server/backends/remote-memory-mirror.js";
import {
  Backend,
  ConflictError,
  DuplicateError,
  MissingNodeError,
  MissingObservationError,
  MissingRelationError,
  Snapshot,
} from "./server/backends/types.js";
import type { Entity, Relation } from "./src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.PORT ?? 3003);
const RESOURCE_URI = "ui://graph-view/graph.html";
const RESOLVED = resolveBackend();
const MEMORY_PATH = RESOLVED.path;

// v2.5: graph-view is fundamentally a JSONL renderer — the choice of which
// file to render is a per-call concern, not a process-wide one. Each tool
// accepts an optional `backend` argument; we lazily instantiate one Backend
// per kind and cache it for the process lifetime. The boot-time RESOLVED
// becomes just the default when no `backend` arg is provided.
const backendCache = new Map<"anthropic-file" | "remote-memory-mirror", Backend>();

function getBackend(kindArg?: string): Backend {
  // No arg → boot-time default (preserves prior single-backend behavior).
  const resolved = kindArg
    ? resolveBackend({ forceKind: kindArg })
    : RESOLVED;

  // If the caller explicitly asked for a kind whose path is fallback-only,
  // they almost certainly haven't configured that backend. Surface that
  // instead of silently writing to a hidden default file.
  if (kindArg && resolved.source === "fallback") {
    const envName =
      resolved.kind === "remote-memory-mirror"
        ? "LOCAL_MIRROR_PATH"
        : "MEMORY_FILE_PATH";
    const cfgKey =
      resolved.kind === "remote-memory-mirror"
        ? "mcpServers['remote-memory'].env.LOCAL_MIRROR_PATH"
        : "mcpServers.memory.env.MEMORY_FILE_PATH";
    throw new Error(
      `Backend '${resolved.kind}' is not configured. Set ${envName} env ` +
      `or ${cfgKey} in claude_desktop_config.json.`
    );
  }

  const cached = backendCache.get(resolved.kind);
  if (cached) return cached;

  const instance: Backend =
    resolved.kind === "remote-memory-mirror"
      ? new RemoteMemoryMirrorBackend(resolved.path)
      : new AnthropicFileBackend(resolved.path);
  backendCache.set(resolved.kind, instance);
  return instance;
}

// Pre-warm the default backend so the boot-time backup hook and `/` endpoint
// keep working with no behavior change.
const backend: Backend = getBackend();

function structuredError(
  code:
    | "VERSION_CONFLICT"
    | "DUPLICATE_NAME"
    | "MISSING_NODE"
    | "MISSING_RELATION"
    | "MISSING_OBSERVATION"
    | "INVALID_INPUT"
    | "IO_ERROR",
  message: string,
  extra?: Record<string, unknown>
) {
  const payload = { ok: false as const, code, message, ...(extra ?? {}) };
  return {
    isError: true,
    content: [{ type: "text" as const, text: `[${code}] ${message}` }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

function structuredOk(version: number, payload: Record<string, unknown> = {}) {
  const out = { ok: true as const, version, ...payload };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(out) }],
    structuredContent: out as unknown as Record<string, unknown>,
  };
}

function logMutation(op: string, payload: unknown): void {
  // Audit trail to stderr (does not interfere with stdio MCP).
  console.error(
    `[graph-view] ${new Date().toISOString()} ${op} ${JSON.stringify(payload)}`
  );
}

function errorToResponse(e: unknown) {
  if (e instanceof ConflictError) {
    return structuredError(
      "VERSION_CONFLICT",
      `External change detected (expected ${e.expected}, current ${e.current})`,
      { currentVersion: e.current, expectedVersion: e.expected }
    );
  }
  if (e instanceof DuplicateError) {
    return structuredError("DUPLICATE_NAME", `Already exists: ${e.name}`);
  }
  if (e instanceof MissingNodeError) {
    return structuredError("MISSING_NODE", `Not found: ${e.name}`);
  }
  if (e instanceof MissingRelationError) {
    return structuredError("MISSING_RELATION", `Not found: ${e.id}`);
  }
  if (e instanceof MissingObservationError) {
    return structuredError("MISSING_OBSERVATION", e.message);
  }
  if (e instanceof IoError) {
    return structuredError("IO_ERROR", e.message);
  }
  if (e instanceof z.ZodError) {
    return structuredError("INVALID_INPUT", e.message);
  }
  return structuredError(
    "IO_ERROR",
    e instanceof Error ? e.message : String(e)
  );
}

// ─── Zod schemas (module scope) ───────────────────────────────────────────────

// Backend selector accepted across all tools. Canonical pair first; aliases
// follow for ergonomics (e.g. LLM may say "memory" or "remote-memory").
const BackendKindEnum = z
  .enum([
    "anthropic-file",
    "anthropic",
    "memory",
    "remote-memory-mirror",
    "remote-memory",
    "mirror",
  ])
  .describe(
    "Which JSONL backend to read/write. " +
      "'anthropic-file' (alias: 'anthropic', 'memory') = local memory MCP file (MEMORY_FILE_PATH). " +
      "'remote-memory-mirror' (alias: 'remote-memory', 'mirror') = remote-memory MCP's LOCAL_MIRROR_PATH file. " +
      "Omit to use the boot-time default."
  );

const ShowGraphInput = z.object({
  entityTypes: z.array(z.string()).optional(),
  query: z.string().optional(),
  neighborhoodOf: z.string().optional(),
  depth: z.number().int().min(1).max(3).default(2),
  title: z.string().optional(),
  layout: z.enum(["fcose", "concentric", "grid"]).default("fcose"),
  theme: z.enum(["dark", "light", "auto"]).default("auto"),
  height: z
    .number()
    .int()
    .min(300)
    .max(2000)
    .default(640)
    .describe("Iframe height in pixels (the host may honor this as a hint)."),
  backend: BackendKindEnum.optional(),
});

// ─── UI capability documentation ─────────────────────────────────────────────
// Surfaced to the LLM in tool descriptions AND via the `graph_view_help` tool
// AND via `updateModelContext` at iframe boot. The model should know exactly
// what the human sees and can do, so it can guide the user through the UI.

const UI_MANUAL = `
# graph-view UI — what the human sees

When 'show_memory_graph' renders, the user gets an interactive 2D mind-map.

## Layout
- **Header**: brand, current title, "X nodes · Y relations" stat, reload (↻) and fullscreen (⛶) buttons.
- **Toolbar**: search input, type filter dropdown, layout dropdown (fcose/concentric/grid),
  zoom presets (0.5x/1x/2x/⤢ fit), [⚠ orphans] button, [+ node] button, [+ relation] button.
- **Canvas (left)**: cytoscape graph. Nodes colored by entityType. Edges labeled with relationType.
- **Side panel (right)**: details of the currently selected node or edge,
  with inline observation add/delete and Edit/Delete actions.
- **Footer**: backend, current version (file mtime), toast area.

## User actions
- **Click node/edge** → side panel shows its details; 1-hop neighborhood highlighted, rest dimmed.
- **Click empty canvas** → deselects.
- **Right-click node/edge/canvas** → context menu (Delete, Add observation, Add node here).
- **Shift + drag from a node onto another node** → creates an edge; prompts for relationType.
- **Drag a node without shift** → moves the node.
- **Toolbar [+ relation]** → modal to connect any two existing nodes by name (with autocomplete).
- **Toolbar [+ node]** → modal to create new entity (name, type, observations).
- **Toolbar [⚠ orphans]** → wizard listing nodes with zero relations; can send a request
  to Claude (via sendMessage) to analyze observations and propose relations.
- **Reload (↻)**: re-reads memory.json from disk. Also runs automatically every 5s — if you
  (Claude) edit memory via the memory MCP, the iframe will refresh on its own.

## Keyboard
- Esc: deselect.
- Delete/Backspace: delete selected node or edge (confirms first).
- Ctrl/Cmd+F: focus search.
- n: open [+ node] modal.

## Hierarchical visualization (compound nodes)
The following relation types render as **parent-child containment** instead of edges:
  - contains, has_a, parent_of   (from = parent, to = child)
  - part_of, is_a, child_of      (to = parent, from = child)
This lets the user see structural hierarchy without changing memory schema.
Use these relation names when modeling structural composition.

## How the LLM should help the user
- When the user edits in the UI, you'll receive 'updateModelContext' notifications
  describing the change (type, summary, detail). Use these to stay in sync without
  re-calling read_graph.
- If the user asks "show me my memory" or similar, call show_memory_graph (no args
  needed for full graph; use 'query' or 'entityTypes' filters when scope is given).
- When the user asks to connect/organize/clean orphan nodes from the UI, that flow
  comes through as a normal user message (via sendMessage). Treat it as a normal
  request and call create_relations on the memory MCP — graph-view will auto-refresh.
- For relationType naming, prefer active voice and consistent vocabulary
  (works_at, uses, depends_on, contains, part_of, is_a). Reusing existing types
  keeps the graph readable.

## Tool surface (graph-view server)
- show_memory_graph — open/refresh the iframe view (UI tool)
- reload_graph — re-read disk and return current snapshot (no UI)
- create_entity / update_entity / delete_entity
- add_observations / delete_observations
- create_relation / delete_relation
- graph_view_help — return this manual

Use show_memory_graph to surface the UI. Use the CRUD tools to mutate when the user
asks via natural language (e.g., "add a node X to my memory"). The user can also
make the same edits in the UI — either path stays consistent because graph-view
writes the same memory.json that the memory MCP reads.
`.trim();

const UI_BRIEF =
  "graph-view UI renders in an iframe. Users can: click nodes to focus, " +
  "shift+drag to connect, use toolbar [+ node]/[+ relation]/[⚠ orphans] buttons, " +
  "Delete key removes selection. Structural relations (contains, part_of, is_a, has_a, " +
  "parent_of, child_of) render as parent-child containers, not edges. " +
  "Auto-refreshes every 5s — if you mutate via memory MCP, the user's view updates. " +
  "Call graph_view_help for the full manual.";

// Backend hint appended to show_memory_graph's tool description. v2.5+
// supports per-call backend selection via the `backend` arg, so the hint
// covers BOTH backends rather than the single boot-time choice.
const BACKEND_HINT =
  "\n\nBackend selection: pass `backend: \"anthropic-file\"` to render the local " +
  "memory MCP file (MEMORY_FILE_PATH) or `backend: \"remote-memory-mirror\"` to " +
  "render the remote-memory mirror (LOCAL_MIRROR_PATH). Omit `backend` for the " +
  "auto-detected default.\n\n" +
  "When rendering or mutating the remote-memory mirror, note that local edits do " +
  "NOT auto-push to GitHub. If the user asks to publish, call `remote-memory.sync_push` " +
  "directly (separate MCP). For latest GitHub state, call `remote-memory.sync_pull` — " +
  "graph-view auto-refreshes on the next 5-second polling tick. On `diverged` status, " +
  "call `remote-memory.force_sync` only after explicit user consent.";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Filter a snapshot's entities/relations to a visible subset.
 * Mirrors the show_memory_graph filtering pipeline (entityTypes / query /
 * neighborhoodOf N-hop). Pure function over already-loaded snapshot.
 */
function filterSnapshot(
  snap: Snapshot,
  parsed: z.infer<typeof ShowGraphInput>
): { entities: Entity[]; relations: Relation[] } | { error: ReturnType<typeof structuredError> } {
  let entities = snap.entities.slice();
  const relations = snap.relations;

  if (parsed.entityTypes && parsed.entityTypes.length > 0) {
    const allow = new Set(parsed.entityTypes);
    entities = entities.filter((e) => allow.has(e.entityType));
  }

  if (parsed.query) {
    const needle = parsed.query.toLowerCase();
    entities = entities.filter((e) => {
      const hay =
        e.name.toLowerCase() +
        "\n" +
        e.entityType.toLowerCase() +
        "\n" +
        e.observations.join("\n").toLowerCase();
      return hay.includes(needle);
    });
  }

  if (parsed.neighborhoodOf) {
    const seed = parsed.neighborhoodOf;
    if (!snap.entities.some((e) => e.name === seed)) {
      return {
        error: structuredError(
          "MISSING_NODE",
          `neighborhoodOf seed '${seed}' not found`
        ),
      };
    }
    const visible = new Set<string>([seed]);
    let frontier = new Set<string>([seed]);
    for (let d = 0; d < parsed.depth; d++) {
      const next = new Set<string>();
      for (const r of relations) {
        if (frontier.has(r.from) && !visible.has(r.to)) {
          next.add(r.to);
          visible.add(r.to);
        }
        if (frontier.has(r.to) && !visible.has(r.from)) {
          next.add(r.from);
          visible.add(r.from);
        }
      }
      if (next.size === 0) break;
      frontier = next;
    }
    entities = entities.filter((e) => visible.has(e.name));
  }

  const visibleNames = new Set(entities.map((e) => e.name));
  const filteredRelations = relations.filter(
    (r) => visibleNames.has(r.from) && visibleNames.has(r.to)
  );
  return { entities, relations: filteredRelations };
}

// ─── MCP Server factory ──────────────────────────────────────────────────────
// McpServer only supports one transport at a time. The Streamable HTTP
// transport is stateless, so we create a fresh server instance per request.

function createServer(): McpServer {
  const server = new McpServer({ name: "graph-view", version: "0.1.0" });

registerAppTool(
  server,
  "show_memory_graph",
  {
    title: "Show Memory Graph",
    description:
      "Render the MCP memory knowledge graph as an interactive 2D mind-map iframe. " +
      "Supports filtering by entityType, substring search, and N-hop neighborhood. " +
      "After this opens, the user can directly add/edit/delete entities, draw " +
      "relations by shift+dragging between nodes, and clean orphan nodes via the " +
      "[⚠ orphans] wizard. The view auto-refreshes every 5s, so if you mutate the " +
      "graph via memory MCP tools, the user's view updates without re-calling. " +
      "Call `graph_view_help` for the full UI manual the user is seeing." +
      BACKEND_HINT,
    inputSchema: ShowGraphInput.shape,
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  },
  async (args) => {
    try {
      const parsed = ShowGraphInput.parse(args);
      const snap = await getBackend(parsed.backend).load();
      const filtered = filterSnapshot(snap, parsed);
      if ("error" in filtered) return filtered.error;

      const out = {
        entities: filtered.entities,
        relations: filtered.relations,
        version: snap.version,
        backend: snap.info,
        source: snap.source,
        title: parsed.title,
        layout: parsed.layout,
        theme: parsed.theme,
        height: parsed.height,
        uiBrief: UI_BRIEF,
      };

      const summary =
        `Graph loaded: ${filtered.entities.length} nodes, ${filtered.relations.length} relations ` +
        `(backend=${snap.info.kind}, version=${snap.version})`;
      return {
        content: [{ type: "text" as const, text: summary }],
        structuredContent: out as unknown as Record<string, unknown>,
      };
    } catch (e) {
      return errorToResponse(e);
    }
  }
);

// ── graph_view_help ───────────────────────────────────────────────────────────

server.registerTool(
  "graph_view_help",
  {
    title: "Graph-view UI Manual",
    description:
      "Return a markdown manual describing what the user sees when graph-view's " +
      "iframe is open, what buttons and keyboard shortcuts exist, and how relations " +
      "and compound nodes work. Call this once per conversation or whenever the " +
      "user asks about the graph-view UI so you can guide them precisely.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text" as const, text: UI_MANUAL }],
  })
);

// ── reload_graph ──────────────────────────────────────────────────────────────

const ReloadGraphInput = z.object({
  backend: BackendKindEnum.optional(),
});

server.registerTool(
  "reload_graph",
  {
    title: "Reload Memory Graph",
    description:
      "Re-read the memory file from disk and return the current snapshot. " +
      "Use after detecting an external change or to resolve a version conflict. " +
      "Optional `backend` arg selects which backend to reload (same values as show_memory_graph).",
    inputSchema: ReloadGraphInput.shape,
  },
  async (args) => {
    try {
      const p = ReloadGraphInput.parse(args);
      const snap = await getBackend(p.backend).load();
      const out = {
        entities: snap.entities,
        relations: snap.relations,
        version: snap.version,
        backend: snap.info,
        source: snap.source,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: `Reloaded: ${snap.entities.length} nodes, ${snap.relations.length} relations`,
          },
        ],
        structuredContent: out as unknown as Record<string, unknown>,
      };
    } catch (e) {
      return errorToResponse(e);
    }
  }
);

// ── create_entity ─────────────────────────────────────────────────────────────

const CreateEntityInput = z.object({
  name: z.string().min(1),
  entityType: z.string().min(1),
  observations: z.array(z.string()).default([]),
  expectedVersion: z.number().int().nonnegative().optional(),
  backend: BackendKindEnum.optional(),
});

server.registerTool(
  "create_entity",
  {
    title: "Create Entity",
    description: "Create a new entity (node) in the memory graph.",
    inputSchema: CreateEntityInput.shape,
  },
  async (args) => {
    try {
      const p = CreateEntityInput.parse(args);
      const now = new Date().toISOString();
      const e: Entity = {
        name: p.name,
        entityType: p.entityType,
        observations: p.observations,
        createdAt: now,
        updatedAt: now,
      };
      const snap = await getBackend(p.backend).createEntity(e, p.expectedVersion);
      logMutation("create_entity", { name: p.name, backend: p.backend ?? "default" });
      const created = snap.entities.find((x) => x.name === p.name) ?? e;
      return structuredOk(snap.version, { entity: created });
    } catch (e) {
      return errorToResponse(e);
    }
  }
);

// ── update_entity ─────────────────────────────────────────────────────────────

const UpdateEntityInput = z.object({
  name: z.string().min(1),
  newName: z.string().min(1).optional(),
  entityType: z.string().min(1).optional(),
  observations: z.array(z.string()).optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
  backend: BackendKindEnum.optional(),
});

server.registerTool(
  "update_entity",
  {
    title: "Update Entity",
    description:
      "Modify an existing entity. Supports rename (newName), entityType change, " +
      "and full observations replace. Rename rewires all relations.",
    inputSchema: UpdateEntityInput.shape,
  },
  async (args) => {
    try {
      const p = UpdateEntityInput.parse(args);
      const snap = await getBackend(p.backend).updateEntity(
        p.name,
        {
          newName: p.newName,
          entityType: p.entityType,
          observations: p.observations,
        },
        p.expectedVersion
      );
      logMutation("update_entity", { name: p.name, newName: p.newName, backend: p.backend ?? "default" });
      const finalName = p.newName ?? p.name;
      const updated = snap.entities.find((x) => x.name === finalName);
      return structuredOk(snap.version, { entity: updated });
    } catch (e) {
      return errorToResponse(e);
    }
  }
);

// ── delete_entity ─────────────────────────────────────────────────────────────

const DeleteEntityInput = z.object({
  name: z.string().min(1),
  expectedVersion: z.number().int().nonnegative().optional(),
  backend: BackendKindEnum.optional(),
});

server.registerTool(
  "delete_entity",
  {
    title: "Delete Entity",
    description:
      "Delete an entity and all relations touching it. Irreversible (use carefully).",
    inputSchema: DeleteEntityInput.shape,
  },
  async (args) => {
    try {
      const p = DeleteEntityInput.parse(args);
      const { snapshot, deletedRelations } = await getBackend(p.backend).deleteEntity(
        p.name,
        p.expectedVersion
      );
      logMutation("delete_entity", { name: p.name, backend: p.backend ?? "default" });
      return structuredOk(snapshot.version, { deletedRelations });
    } catch (e) {
      return errorToResponse(e);
    }
  }
);

// ── add_observations ──────────────────────────────────────────────────────────

const AddObservationsInput = z.object({
  name: z.string().min(1),
  contents: z.array(z.string()).min(1),
  expectedVersion: z.number().int().nonnegative().optional(),
  backend: BackendKindEnum.optional(),
});

server.registerTool(
  "add_observations",
  {
    title: "Add Observations",
    description: "Append observation strings to an existing entity.",
    inputSchema: AddObservationsInput.shape,
  },
  async (args) => {
    try {
      const p = AddObservationsInput.parse(args);
      const { snapshot, addedCount } = await getBackend(p.backend).addObservations(
        p.name,
        p.contents,
        p.expectedVersion
      );
      logMutation("add_observations", {
        name: p.name,
        requested: p.contents.length,
        added: addedCount,
        backend: p.backend ?? "default",
      });
      const entity = snapshot.entities.find((x) => x.name === p.name);
      return structuredOk(snapshot.version, { entity, addedCount });
    } catch (e) {
      return errorToResponse(e);
    }
  }
);

// ── delete_observations ───────────────────────────────────────────────────────

const DeleteObservationsInput = z.object({
  name: z.string().min(1),
  contents: z.array(z.string()).min(1),
  expectedVersion: z.number().int().nonnegative().optional(),
  backend: BackendKindEnum.optional(),
});

server.registerTool(
  "delete_observations",
  {
    title: "Delete Observations",
    description: "Remove observation strings (exact match) from an entity.",
    inputSchema: DeleteObservationsInput.shape,
  },
  async (args) => {
    try {
      const p = DeleteObservationsInput.parse(args);
      const snap = await getBackend(p.backend).deleteObservations(
        p.name,
        p.contents,
        p.expectedVersion
      );
      logMutation("delete_observations", { name: p.name, backend: p.backend ?? "default" });
      const entity = snap.entities.find((x) => x.name === p.name);
      return structuredOk(snap.version, { entity });
    } catch (e) {
      return errorToResponse(e);
    }
  }
);

// ── create_relation ───────────────────────────────────────────────────────────

const CreateRelationInput = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relationType: z.string().min(1),
  expectedVersion: z.number().int().nonnegative().optional(),
  backend: BackendKindEnum.optional(),
});

server.registerTool(
  "create_relation",
  {
    title: "Create Relation",
    description:
      "Create a directed relation between two existing entities. " +
      "Both 'from' and 'to' must already exist as nodes.",
    inputSchema: CreateRelationInput.shape,
  },
  async (args) => {
    try {
      const p = CreateRelationInput.parse(args);
      const r: Relation = {
        from: p.from,
        to: p.to,
        relationType: p.relationType,
      };
      const snap = await getBackend(p.backend).createRelation(r, p.expectedVersion);
      logMutation("create_relation", { ...r, backend: p.backend ?? "default" });
      return structuredOk(snap.version, { relation: r });
    } catch (e) {
      return errorToResponse(e);
    }
  }
);

// ── delete_relation ───────────────────────────────────────────────────────────

const DeleteRelationInput = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relationType: z.string().min(1),
  expectedVersion: z.number().int().nonnegative().optional(),
  backend: BackendKindEnum.optional(),
});

server.registerTool(
  "delete_relation",
  {
    title: "Delete Relation",
    description: "Remove a relation. Triple (from, to, relationType) must match exactly.",
    inputSchema: DeleteRelationInput.shape,
  },
  async (args) => {
    try {
      const p = DeleteRelationInput.parse(args);
      const snap = await getBackend(p.backend).deleteRelation(
        { from: p.from, to: p.to, relationType: p.relationType },
        p.expectedVersion
      );
      logMutation("delete_relation", { ...p, backend: p.backend ?? "default" });
      return structuredOk(snap.version);
    } catch (e) {
      return errorToResponse(e);
    }
  }
);

// ── Resource: UI HTML ─────────────────────────────────────────────────────────

registerAppResource(
  server,
  RESOURCE_URI,
  RESOURCE_URI,
  { mimeType: RESOURCE_MIME_TYPE },
  async () => {
    const html = await fs.readFile(
      path.join(__dirname, "dist", "graph.html"),
      "utf-8"
    );
    return {
      contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
    };
  }
);

  return server;
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    server: "graph-view",
    version: "0.1.0",
    port: PORT,
    backend: backend.info(),
    memoryPath: MEMORY_PATH,
  });
});

app.all("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[graph-view] /mcp error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

const STDIO_MODE = process.argv.includes("--stdio");

async function main() {
  const bak = await backupOnStart(MEMORY_PATH).catch((e) => {
    console.error(`[graph-view] backup failed (non-fatal): ${(e as Error).message}`);
    return null;
  });
  if (bak) console.error(`[graph-view] backup created: ${bak}`);
  console.error(
    `[graph-view] memory path: ${MEMORY_PATH} (source: ${RESOLVED.source})`
  );
  console.error(
    `[graph-view] backend: ${RESOLVED.kind} (${backend.info().label})`
  );
  if (RESOLVED.source === "fallback") {
    const hint =
      RESOLVED.kind === "remote-memory-mirror"
        ? `Set LOCAL_MIRROR_PATH env or 'remote-memory' MCP entry in claude_desktop_config.json.`
        : `Set MEMORY_FILE_PATH env or 'memory' MCP entry in claude_desktop_config.json.`;
    console.error(`[graph-view] WARNING: using last-resort default path. ${hint}`);
  }

  if (STDIO_MODE) {
    // Single-session stdio: one server, one transport, for Claude Desktop / CLI.
    const server = createServer();
    await server.connect(new StdioServerTransport());
    console.error(`[graph-view] MCP server connected via stdio`);
  } else {
    app.listen(PORT, () => {
      console.error(`[graph-view] MCP server at http://localhost:${PORT}/mcp`);
    });
  }
}

main().catch((e) => {
  console.error("[graph-view] fatal:", e);
  process.exit(1);
});
