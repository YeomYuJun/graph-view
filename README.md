# Graph View MCP Server

An MCP server that renders the knowledge graph used by the official [`memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) MCP (and compatible backends like [remote-memory-mcp-server](https://github.com/YeomYuJun/remote-memory-mcp-server)) as a **2D mind-map** rendered inline in the chat. Users can pan and zoom the graph, see the structure at a glance, and ask the LLM to mutate it; the iframe auto-refreshes when the underlying file changes.

`graph-view` does not own the data. It is a **lens** over the JSONL file already maintained by another MCP. Multiple lenses, one source of truth.

<p align="center">
  <img src="./media/graph-view-sample.gif" alt="Graph View demo" width="600" />
</p>

Using `memory`, built with MCP Apps, running in Claude.

## Built on MCP Apps

Under the hood, graph-view is an [**MCP App**](https://apps.extensions.modelcontextprotocol.io) — the SDK pattern that lets an MCP server ship an interactive HTML surface which the host loads into a sandboxed iframe alongside the conversation, communicating back through a standard postMessage / JSON-RPC dialect. This project would not exist without the foundation laid by the [MCP Apps extension](https://github.com/modelcontextprotocol/ext-apps) and its package [`@modelcontextprotocol/ext-apps`](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps), both maintained by the Model Context Protocol team. Respect and credit to the maintainers.

If you want to understand how the iframe surface, tool-result-to-app push, and `updateModelContext` semantics work, the [specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) and [example apps](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples) (graph-view fits the *Data exploration* family — see `cohort-heatmap-server`, `wiki-explorer-server`) are the right entry points.

> **Host support**: graph-view uses only the standard MCP Apps surface, so the iframe should render in any host that implements the extension — currently [Claude](https://claude.ai), [Claude Desktop](https://claude.ai/download), [VS Code GitHub Copilot](https://code.visualstudio.com/), [Goose](https://block.github.io/goose/), [Postman](https://postman.com/), and [MCPJam](https://www.mcpjam.com/) (see the [client matrix](https://modelcontextprotocol.io/extensions/client-matrix) for the up-to-date list). This project has been primarily developed and verified against Claude Desktop; other hosts have not been tested directly but are expected to work, since no Claude-specific behavior is used.

## Why Graph View

`memory` MCP gives Claude a persistent knowledge graph, but the user only ever sees the raw JSON. As the graph grows past a few dozen nodes, the structure becomes invisible — relations get tangled, orphan entities accumulate, and the user has no good way to verify or correct what Claude has been remembering.

Graph View solves this by giving the human a real graph editor inside the chat:

- **See the whole graph at once** — force-directed 2D layout with type-based coloring
- **Stay synchronized** — graph-view reads the same JSONL file the memory MCP writes. Auto-refreshes every 5 seconds, so when Claude mutates the graph through memory tools the iframe updates without re-rendering.
- **Multiple backends** — switch between the local `memory` MCP file and a GitHub-backed `remote-memory-mcp-server` mirror on a per-call basis

## Core Concepts

Graph View shares its data model with the official [`memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) MCP, so all concepts there apply identically here. A quick recap:

### Entities
The primary nodes. Each has a unique `name`, an `entityType` (e.g. `"Person"`, `"Project"`), and an array of `observations`. Graph View also tracks `createdAt` / `updatedAt` timestamps for listing and sorting.

### Relations
Directed edges between entities, expressed in active voice. `from`, `to`, `relationType`.

### Observations
Discrete string facts attached to a specific entity. Atomic, addable and removable independently.

### Hierarchical relations (graph-view specific)
The following `relationType` values are rendered as **parent–child compound nodes** instead of normal edges, letting users see structural hierarchy without changing the underlying schema:

| Parent–child direction | Relation types |
|---|---|
| `from` is parent, `to` is child | `contains`, `has_a`, `parent_of` |
| `to` is parent, `from` is child | `part_of`, `is_a`, `child_of` |

For example, `Study --part_of--> Manor` is drawn as Manor visually containing Study.

## Backends

Graph View is fundamentally a JSONL renderer; the choice of which file to render is a per-call concern. Every tool accepts an optional `backend` argument:

| `backend` value (aliases) | Source file | Use with |
|---|---|---|
| `"anthropic-file"` (`"anthropic"`, `"memory"`) | `MEMORY_FILE_PATH` env, or `mcpServers.memory.env.MEMORY_FILE_PATH` from `claude_desktop_config.json` | Official [`memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) MCP |
| `"remote-memory-mirror"` (`"remote-memory"`, `"mirror"`) | `LOCAL_MIRROR_PATH` env, or `mcpServers["remote-memory"].env.LOCAL_MIRROR_PATH` | [remote-memory-mcp-server](https://github.com/YeomYuJun/remote-memory-mcp-server) (GitHub-backed sync) |

If `backend` is omitted, graph-view auto-detects: `LOCAL_MIRROR_PATH` present → mirror, else anthropic-file. Each backend kind is lazily instantiated and cached for the process lifetime.

**Note**: When rendering or mutating the remote-memory mirror, local edits do **not** auto-push to GitHub. The LLM should call `remote-memory.sync_push` / `sync_pull` directly when the user asks to publish or refresh from GitHub. Graph-view's 5-second polling will pick up any mirror file changes automatically.

## Installation

```bash
git clone https://github.com/YeomYuJun/graph-view-mcp-server.git
cd graph-view-mcp-server
npm install
```

The `prepare` script runs `vite build` automatically on install, producing `dist/graph.html` — the bundled iframe UI that the server hands to Claude Desktop at runtime.

## Usage with Claude Desktop

### Setup — `memory` MCP + Graph View

Minimal setup. Replace `C:\\path\\to\\graph-view\\` with your actual checkout path.

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-memory"
      ],
      "env": {
        "MEMORY_FILE_PATH": "C:\\memory\\memory.json"
      }
    },
    "graph-view": {
      "command": "node",
      "args": [
        "C:\\path\\to\\graph-view\\node_modules\\tsx\\dist\\cli.mjs",
        "C:\\path\\to\\graph-view\\server.ts",
        "--stdio"
      ]
    }
  }
}
```

Both MCPs read and write the same `MEMORY_FILE_PATH`. The user can edit nodes in graph-view; Claude sees the result through `memory`'s tools on the next turn.

> **Why `node ... tsx/dist/cli.mjs` instead of `npx tsx`?**
> Claude Desktop launches the MCP server with an external working directory, so `npx tsx` cannot find the locally installed `tsx` and falls back to downloading it — which fails on a corrupted npx cache and crashes the server. Pointing `node` at the local `tsx` binary directly bypasses npx entirely. On macOS/Linux the path becomes `node_modules/tsx/dist/cli.mjs` too (same file under the project root).

### Setup — with `remote-memory-mcp-server` (GitHub-backed)

If you also use [remote-memory-mcp-server](https://github.com/YeomYuJun/remote-memory-mcp-server) for cross-machine sync, register all three. graph-view auto-detects `LOCAL_MIRROR_PATH` and becomes the mirror's lens by default:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": {
        "MEMORY_FILE_PATH": "C:\\memory\\memory.json"
      }
    },
    "remote-memory": {
      "command": "node",
      "args": ["C:\\path\\to\\remote-memory-mcp-server\\dist\\index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_...",
        "GITHUB_OWNER": "YourGithubUser",
        "GITHUB_REPO": "your-memory-repo",
        "GITHUB_BRANCH": "main",
        "SYNC_INTERVAL": "0",
        "AUTO_PUSH": "false",
        "LOCAL_MIRROR_PATH": "C:\\path\\to\\remote-memory-mcp-server\\memory.jsonl"
      }
    },
    "graph-view": {
      "command": "node",
      "args": [
        "C:\\path\\to\\graph-view\\node_modules\\tsx\\dist\\cli.mjs",
        "C:\\path\\to\\graph-view\\server.ts",
        "--stdio"
      ]
    }
  }
}
```

You can now ask Claude things like:

- *"Show me my local memory graph"* → Claude calls `show_memory_graph({ backend: "anthropic-file" })`
- *"Show me the remote-memory graph"* → Claude calls `show_memory_graph({ backend: "remote-memory-mirror" })`
- *"Publish my changes to GitHub"* → Claude calls `remote-memory.sync_push`; graph-view's auto-refresh picks up the result

### Optional: forcing the boot-time default

Set `GRAPH_VIEW_BACKEND` to override the auto-detect for the entire process:

```json
"graph-view": {
  "command": "node",
  "args": ["...tsx/dist/cli.mjs", "...server.ts", "--stdio"],
  "env": { "GRAPH_VIEW_BACKEND": "anthropic-file" }
}
```

Per-call `backend` arguments always override this default.

## API

### Tools

#### `show_memory_graph`
Opens the interactive iframe with a filtered view of the graph.

- `entityTypes` (`string[]`, optional): only render entities of these types
- `query` (`string`, optional): substring search on name / type / observations
- `neighborhoodOf` (`string`, optional): show only N-hop neighborhood of this entity
- `depth` (`number`, 1–3, default 2): N-hop depth for `neighborhoodOf`
- `title` (`string`, optional): iframe header text
- `layout` (`"fcose" | "concentric" | "grid"`, default `"fcose"`)
- `theme` (`"dark" | "light" | "auto"`, default `"auto"`)
- `height` (`number`, default 640): iframe height hint
- `backend` (`"anthropic-file" | "remote-memory-mirror"` + aliases, optional): backend selector

#### `reload_graph`
Re-reads the file and returns the current snapshot (no UI). Useful after `sync_pull` or to recover from a version conflict.
- `backend` (optional, same as above)

#### `graph_view_help`
Returns a markdown manual describing the UI the user is seeing — buttons, keyboard shortcuts, relation conventions. Useful to call once per conversation so the LLM can guide users through the iframe.

#### CRUD tools
All accept the optional `backend` arg.

- `create_entity` — `{ name, entityType, observations[], expectedVersion? }`
- `update_entity` — `{ name, newName?, entityType?, observations?, expectedVersion? }` (rename rewires all relations)
- `delete_entity` — `{ name, expectedVersion? }` (cascades to relations)
- `add_observations` — `{ name, contents[], expectedVersion? }`
- `delete_observations` — `{ name, contents[], expectedVersion? }`
- `create_relation` — `{ from, to, relationType, expectedVersion? }`
- `delete_relation` — `{ from, to, relationType, expectedVersion? }`

### Conflict semantics

Every write accepts an optional `expectedVersion` (mtimeMs from a prior load). If the file's mtime no longer matches at write time, the server throws `VERSION_CONFLICT` with the current version, and the iframe presents a "reload" modal to the user. This is graph-view's only concurrency primitive — it's enough because the underlying memory MCP follows the same atomic-write-then-mtime-check pattern.

## UI Overview

When `show_memory_graph` is called, the iframe renders:

- **Header**: title, node/relation count, reload (↻), settings, fullscreen (⛶)
- **Toolbar**: search, type filter, layout dropdown (`fcose` / `concentric` / `grid`), zoom presets
- **Canvas**: a Cytoscape graph. Nodes colored by `entityType`, edges labeled with `relationType`. Structural relations render as compound (parent–child) nodes.
- **Side panel**: details of the currently selected node — name, type, observations, neighbors
- **Footer**: backend label, current version (file mtime), toast area

The iframe is primarily a **viewer**. Most graph mutations happen through Claude — the user asks ("connect Alice and Bob", "add an observation to Project X") and Claude calls the appropriate tool, after which the iframe auto-refreshes within 5 seconds via mtime polling. Some direct iframe interactions are constrained by the host's iframe sandbox; assume edits flow through Claude unless you've verified a particular interaction works in your host.

## System Prompt suggestion

If you want Claude to surface graph-view proactively for memory-heavy conversations, add the following to your Claude project's custom instructions:

```
When the user asks to see, organize, or visually verify their memory graph, call
`show_memory_graph` (no args needed for the full graph; use `query` / `entityTypes` /
`neighborhoodOf` to scope). For routine memory inspection at the start of a
conversation, prefer the textual `memory.read_graph` first; surface the iframe only
when the user explicitly asks for a visual view or when the graph is large enough
that visualization adds value.

Call `graph_view_help` once per conversation to know what the human can do in the
iframe, so you can guide them precisely (e.g. "shift+drag from this node to draw a
relation").

When the user edits in the iframe, you will receive `updateModelContext`
notifications describing the change. Stay in sync without re-calling read_graph.
```

## Development

```bash
npm run build         # vite production build → dist/graph.html
npm run build:watch   # vite watch mode (rebuilds dist on every save)
npm run serve         # run the MCP server (HTTP on port 3003, no UI rebuild)
npm run dev           # build + serve (one-shot)
```

For Claude Desktop testing, the `--stdio` flag is automatically added in the config example above. For HTTP testing (e.g. with `mcp-inspector`), omit `--stdio` and connect to `http://localhost:3003/mcp`.

### Repository layout

```
graph-view/
├── server.ts                       MCP server entry (stdio + HTTP)
├── server/
│   ├── memory-io.ts                JSONL load/save, atomic write, mtime check
│   └── backends/
│       ├── types.ts                Backend interface + error types
│       ├── anthropic-file.ts       Backend for memory MCP's JSONL file
│       └── remote-memory-mirror.ts Backend for remote-memory's LOCAL_MIRROR_PATH
├── src/                            iframe UI (Cytoscape + vanilla TS)
├── graph.html                      vite entry HTML
└── dist/graph.html                 single-file bundle (produced by vite)
```

## License

MIT. See [LICENSE](./LICENSE).
