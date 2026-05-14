import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { Entity, Relation } from "../src/types.js";

export interface RawLine {
  type: "entity" | "relation";
  raw: string;
  index: number;
  parsed: unknown;
}

export interface GraphFile {
  entities: Map<string, Entity>;
  relations: Map<string, Relation>;
  lines: RawLine[];
  version: number;
  path: string;
}

export class ConflictError extends Error {
  constructor(public currentVersion: number, public expectedVersion: number) {
    super(
      `Version conflict: expected ${expectedVersion}, current ${currentVersion}`
    );
    this.name = "ConflictError";
  }
}

export class IoError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "IoError";
  }
}

function relId(r: { from: string; to: string; relationType: string }): string {
  return `${r.from}|${r.relationType}|${r.to}`;
}

export async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "", "utf-8");
  }
}

export async function loadGraph(filePath: string): Promise<GraphFile> {
  await ensureFile(filePath);
  const stat = await fs.stat(filePath);
  const text = await fs.readFile(filePath, "utf-8");

  const entities = new Map<string, Entity>();
  const relations = new Map<string, Relation>();
  const lines: RawLine[] = [];

  const split = text.split(/\r?\n/);
  for (let i = 0; i < split.length; i++) {
    const raw = split[i];
    if (!raw.trim()) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new IoError(
        `Parse failed at line ${i + 1}: ${(e as Error).message}`,
        e
      );
    }
    if (parsed?.type === "entity") {
      const e: Entity = {
        name: String(parsed.name),
        entityType: String(parsed.entityType ?? "unknown"),
        observations: Array.isArray(parsed.observations)
          ? parsed.observations.map((x: unknown) => String(x))
          : [],
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      };
      entities.set(e.name, e);
      lines.push({ type: "entity", raw, index: i, parsed: e });
    } else if (parsed?.type === "relation") {
      const r: Relation = {
        from: String(parsed.from),
        to: String(parsed.to),
        relationType: String(parsed.relationType),
      };
      relations.set(relId(r), r);
      lines.push({ type: "relation", raw, index: i, parsed: r });
    }
    // Unknown types are silently skipped (forward compat).
  }

  return {
    entities,
    relations,
    lines,
    version: Math.floor(stat.mtimeMs),
    path: filePath,
  };
}

function entityToLine(e: Entity): string {
  // anthropic memory format — keys in canonical order.
  // createdAt/updatedAt are persisted when present so a file shared with
  // remote-memory (LOCAL_MIRROR_PATH mode) keeps its metadata round-trip.
  // anthropic memory itself silently ignores unknown fields (forward-compat).
  const out: Record<string, unknown> = {
    type: "entity",
    name: e.name,
    entityType: e.entityType,
    observations: e.observations,
  };
  if (e.createdAt) out.createdAt = e.createdAt;
  if (e.updatedAt) out.updatedAt = e.updatedAt;
  return JSON.stringify(out);
}

function relationToLine(r: Relation): string {
  return JSON.stringify({
    type: "relation",
    from: r.from,
    to: r.to,
    relationType: r.relationType,
  });
}

/**
 * Write the graph back to disk, preserving original line order for surviving
 * entries and appending new ones at the end. Atomic via .tmp + rename.
 *
 * Caller responsibility: pass the *currently modified* entities/relations Maps
 * (e.g., after applying a mutation in memory). lines may be stale — we use it
 * only to honor original ordering.
 */
export async function saveGraph(
  file: GraphFile,
  expectedVersion: number
): Promise<number> {
  // Re-check mtime right before write to minimize race window
  const stat = await fs.stat(file.path);
  const current = Math.floor(stat.mtimeMs);
  if (current !== expectedVersion) {
    throw new ConflictError(current, expectedVersion);
  }

  const outLines: string[] = [];
  const writtenEntities = new Set<string>();
  const writtenRelations = new Set<string>();

  // 1. Preserve original order for entries still present
  for (const ln of file.lines) {
    if (ln.type === "entity") {
      const oldE = ln.parsed as Entity;
      const currentE = file.entities.get(oldE.name);
      if (currentE) {
        outLines.push(entityToLine(currentE));
        writtenEntities.add(currentE.name);
      }
    } else {
      const oldR = ln.parsed as Relation;
      const id = relId(oldR);
      const currentR = file.relations.get(id);
      if (currentR) {
        outLines.push(relationToLine(currentR));
        writtenRelations.add(id);
      }
    }
  }

  // 2. Append new entities/relations
  for (const e of file.entities.values()) {
    if (!writtenEntities.has(e.name)) outLines.push(entityToLine(e));
  }
  for (const [id, r] of file.relations.entries()) {
    if (!writtenRelations.has(id)) outLines.push(relationToLine(r));
  }

  const text = outLines.join("\n") + (outLines.length > 0 ? "\n" : "");

  const tmpPath = file.path + ".tmp." + process.pid + "." + Date.now();
  try {
    await fs.writeFile(tmpPath, text, "utf-8");
    await fs.rename(tmpPath, file.path);
  } catch (e) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw new IoError(`Write failed: ${(e as Error).message}`, e);
  }

  const newStat = await fs.stat(file.path);
  return Math.floor(newStat.mtimeMs);
}

/**
 * Best-effort backup on server start. Keeps last N backups.
 */
export async function backupOnStart(
  filePath: string,
  keep = 5
): Promise<string | null> {
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bakPath = path.join(dir, `${base}.bak.${ts}`);
  await fs.copyFile(filePath, bakPath);

  // prune older backups
  const all = await fs.readdir(dir);
  const baks = all
    .filter((n) => n.startsWith(`${base}.bak.`))
    .sort()
    .reverse();
  for (const old of baks.slice(keep)) {
    try {
      await fs.unlink(path.join(dir, old));
    } catch {
      /* ignore */
    }
  }
  return bakPath;
}

export type ResolvedBackendKind = "anthropic-file" | "remote-memory-mirror";

export interface ResolvedBackend {
  kind: ResolvedBackendKind;
  path: string;
  source: "env" | "claude-desktop-config" | "fallback";
}

export interface ResolvedPath {
  path: string;
  source: "env" | "claude-desktop-config" | "fallback";
}

/**
 * Resolve which backend to use and where its file lives.
 *
 * Priority:
 *   1. opts.forceKind, if provided (used by per-tool-call backend overrides).
 *   2. GRAPH_VIEW_BACKEND env, if set, forces the kind for the process default.
 *   3. Auto-detect: mirror takes precedence over anthropic. If LOCAL_MIRROR_PATH
 *      is configured anywhere, we use the mirror backend (the user has clearly
 *      moved to remote-memory). Otherwise anthropic.
 *
 * Path slot priority within a kind:
 *   - anthropic-file: MEMORY_FILE_PATH env > claude_desktop_config.mcpServers.memory.env.MEMORY_FILE_PATH > fallback
 *   - remote-memory-mirror: LOCAL_MIRROR_PATH env > claude_desktop_config.mcpServers.remote-memory.env.LOCAL_MIRROR_PATH > fallback
 *
 * `opts.forceKind` accepts the same aliases as GRAPH_VIEW_BACKEND env.
 */
export function resolveBackend(opts: { forceKind?: string } = {}): ResolvedBackend {
  const force = ((opts.forceKind ?? process.env.GRAPH_VIEW_BACKEND ?? "") + "")
    .trim()
    .toLowerCase();

  // 1) Explicit kind (per-call arg or env)
  if (force === "remote-memory-mirror" || force === "remote-memory" || force === "mirror") {
    return resolveMirror();
  }
  if (force === "anthropic-file" || force === "anthropic" || force === "memory") {
    return resolveAnthropic();
  }

  // 2) Auto-detect — mirror first
  if (
    process.env.LOCAL_MIRROR_PATH ||
    readMirrorPathFromClaudeDesktopConfig() != null
  ) {
    return resolveMirror();
  }

  // 3) Anthropic default
  return resolveAnthropic();
}

function resolveAnthropic(): ResolvedBackend {
  const env = process.env.MEMORY_FILE_PATH;
  if (env) return { kind: "anthropic-file", path: path.normalize(env), source: "env" };
  const fromConfig = readMemoryPathFromClaudeDesktopConfig();
  if (fromConfig) {
    return { kind: "anthropic-file", path: path.normalize(fromConfig), source: "claude-desktop-config" };
  }
  return { kind: "anthropic-file", path: fallbackPath("memory.jsonl"), source: "fallback" };
}

function resolveMirror(): ResolvedBackend {
  const env = process.env.LOCAL_MIRROR_PATH;
  if (env) return { kind: "remote-memory-mirror", path: path.normalize(env), source: "env" };
  const fromConfig = readMirrorPathFromClaudeDesktopConfig();
  if (fromConfig) {
    return { kind: "remote-memory-mirror", path: path.normalize(fromConfig), source: "claude-desktop-config" };
  }
  return { kind: "remote-memory-mirror", path: fallbackPath("memory.jsonl"), source: "fallback" };
}

function fallbackPath(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.normalize(path.join(here, name));
}

/** @deprecated v2.0 — kept for compatibility. Use resolveBackend() instead. */
export function resolveMemoryPath(): ResolvedPath {
  const r = resolveBackend();
  return { path: r.path, source: r.source };
}

function claudeDesktopConfigPath(): string | null {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json"
    );
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function readClaudeDesktopConfig(): Record<string, unknown> | null {
  const cfgPath = claudeDesktopConfigPath();
  if (!cfgPath) return null;
  try {
    const text = fsSync.readFileSync(cfgPath, "utf-8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readMemoryPathFromClaudeDesktopConfig(): string | null {
  const cfg = readClaudeDesktopConfig() as any;
  const v = cfg?.mcpServers?.memory?.env?.MEMORY_FILE_PATH;
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function readMirrorPathFromClaudeDesktopConfig(): string | null {
  const cfg = readClaudeDesktopConfig() as any;
  const v = cfg?.mcpServers?.["remote-memory"]?.env?.LOCAL_MIRROR_PATH;
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}
