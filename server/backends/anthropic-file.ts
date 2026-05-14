import fs from "node:fs/promises";
import path from "node:path";
import type { Entity, Relation, BackendInfo } from "../../src/types.js";
import {
  loadGraph,
  saveGraph,
  ConflictError as IoConflictError,
} from "../memory-io.js";
import type { GraphFile } from "../memory-io.js";
import {
  Backend,
  ConflictError,
  DuplicateError,
  EntityPatch,
  MissingNodeError,
  MissingObservationError,
  MissingRelationError,
  Snapshot,
  VersionToken,
} from "./types.js";

function relId(r: { from: string; to: string; relationType: string }): string {
  return `${r.from}|${r.relationType}|${r.to}`;
}

function fileToSnapshot(file: GraphFile, info: BackendInfo): Snapshot {
  return {
    entities: Array.from(file.entities.values()),
    relations: Array.from(file.relations.values()),
    version: file.version,
    info,
    source: { path: file.path },
  };
}

/**
 * Backend that reads/writes the official anthropic memory MCP's JSONL format
 * directly on the local filesystem. This is graph-view v1's behavior, now
 * exposed through the Backend interface.
 *
 * Safety properties preserved from v1:
 *   - atomic write via .tmp + rename (in saveGraph)
 *   - mtime-based version token + ConflictError on concurrent writes
 *   - line-order preservation (saveGraph honors original ordering)
 */
export class AnthropicFileBackend implements Backend {
  constructor(
    private filePath: string,
    private kindOverride: "anthropic-file" | "remote-memory-mirror" = "anthropic-file"
  ) {}

  info(): BackendInfo {
    const isMirror = this.kindOverride === "remote-memory-mirror";
    return {
      kind: this.kindOverride,
      label: isMirror
        ? `remote-memory · ${path.basename(this.filePath)}`
        : `anthropic · ${path.basename(this.filePath)}`,
      source: { path: this.filePath },
      capabilities: { githubSync: false, metadata: true },
    };
  }

  async load(): Promise<Snapshot> {
    const file = await loadGraph(this.filePath);
    return fileToSnapshot(file, this.info());
  }

  async pollVersion(): Promise<VersionToken> {
    const stat = await fs.stat(this.filePath);
    return Math.floor(stat.mtimeMs);
  }

  private async withFile<T>(
    expected: VersionToken | undefined,
    mutator: (file: GraphFile) => T | Promise<T>
  ): Promise<{ result: T; snapshot: Snapshot }> {
    const file = await loadGraph(this.filePath);
    if (expected != null && expected !== file.version) {
      throw new ConflictError(file.version, expected);
    }
    const result = await mutator(file);
    try {
      const newVersion = await saveGraph(file, file.version);
      file.version = newVersion;
    } catch (e) {
      if (e instanceof IoConflictError) {
        throw new ConflictError(e.currentVersion, e.expectedVersion);
      }
      throw e;
    }
    return { result, snapshot: fileToSnapshot(file, this.info()) };
  }

  async createEntity(e: Entity, expected?: VersionToken): Promise<Snapshot> {
    const { snapshot } = await this.withFile(expected, (file) => {
      if (file.entities.has(e.name)) throw new DuplicateError(e.name);
      file.entities.set(e.name, e);
    });
    return snapshot;
  }

  async updateEntity(
    name: string,
    patch: EntityPatch,
    expected?: VersionToken
  ): Promise<Snapshot> {
    const { snapshot } = await this.withFile(expected, (file) => {
      const cur = file.entities.get(name);
      if (!cur) throw new MissingNodeError(name);

      const finalName = patch.newName ?? cur.name;
      if (patch.newName && patch.newName !== cur.name && file.entities.has(patch.newName)) {
        throw new DuplicateError(patch.newName);
      }

      const next: Entity = {
        name: finalName,
        entityType: patch.entityType ?? cur.entityType,
        observations: patch.observations ?? cur.observations,
        createdAt: cur.createdAt,
        updatedAt: new Date().toISOString(),
      };

      if (patch.newName && patch.newName !== cur.name) {
        file.entities.delete(cur.name);
        const newRels = new Map<string, Relation>();
        for (const [, r] of file.relations) {
          const nr: Relation = {
            from: r.from === cur.name ? finalName : r.from,
            to: r.to === cur.name ? finalName : r.to,
            relationType: r.relationType,
          };
          newRels.set(relId(nr), nr);
        }
        file.relations.clear();
        for (const [k, v] of newRels) file.relations.set(k, v);
      }
      file.entities.set(finalName, next);
    });
    return snapshot;
  }

  async deleteEntity(
    name: string,
    expected?: VersionToken
  ): Promise<{ snapshot: Snapshot; deletedRelations: number }> {
    const { result, snapshot } = await this.withFile(expected, (file) => {
      if (!file.entities.has(name)) throw new MissingNodeError(name);
      file.entities.delete(name);
      let removed = 0;
      for (const [id, r] of Array.from(file.relations.entries())) {
        if (r.from === name || r.to === name) {
          file.relations.delete(id);
          removed++;
        }
      }
      return removed;
    });
    return { snapshot, deletedRelations: result };
  }

  async addObservations(
    name: string,
    contents: string[],
    expected?: VersionToken
  ): Promise<{ snapshot: Snapshot; addedCount: number }> {
    const { result, snapshot } = await this.withFile(expected, (file) => {
      const cur = file.entities.get(name);
      if (!cur) throw new MissingNodeError(name);
      const existing = new Set(cur.observations);
      const added = contents.filter((c) => !existing.has(c));
      const next: Entity = {
        ...cur,
        observations: [...cur.observations, ...added],
        updatedAt: new Date().toISOString(),
      };
      file.entities.set(name, next);
      return added.length;
    });
    return { snapshot, addedCount: result };
  }

  async deleteObservations(
    name: string,
    contents: string[],
    expected?: VersionToken
  ): Promise<Snapshot> {
    const { snapshot } = await this.withFile(expected, (file) => {
      const cur = file.entities.get(name);
      if (!cur) throw new MissingNodeError(name);
      const drop = new Set(contents);
      const remaining = cur.observations.filter((o) => !drop.has(o));
      const removed = cur.observations.length - remaining.length;
      if (removed === 0) throw new MissingObservationError(name);
      file.entities.set(name, {
        ...cur,
        observations: remaining,
        updatedAt: new Date().toISOString(),
      });
    });
    return snapshot;
  }

  async createRelation(r: Relation, expected?: VersionToken): Promise<Snapshot> {
    const { snapshot } = await this.withFile(expected, (file) => {
      if (!file.entities.has(r.from)) throw new MissingNodeError(r.from);
      if (!file.entities.has(r.to)) throw new MissingNodeError(r.to);
      const id = relId(r);
      if (file.relations.has(id)) throw new DuplicateError(`relation ${id}`);
      file.relations.set(id, r);
    });
    return snapshot;
  }

  async deleteRelation(r: Relation, expected?: VersionToken): Promise<Snapshot> {
    const { snapshot } = await this.withFile(expected, (file) => {
      const id = relId(r);
      if (!file.relations.has(id)) throw new MissingRelationError(id);
      file.relations.delete(id);
    });
    return snapshot;
  }

  async dispose(): Promise<void> {
    // no resources held
  }
}
