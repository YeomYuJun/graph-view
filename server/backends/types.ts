import type { Entity, Relation, BackendInfo } from "../../src/types.js";

/**
 * Opaque version token. Backend-specific meaning (mtime for file-based,
 * could be a hash or revision for others). graph-view only compares for
 * equality. Kept as `number` in v2.0 since both shipped backends use mtimeMs.
 */
export type VersionToken = number;

export interface Snapshot {
  entities: Entity[];
  relations: Relation[];
  version: VersionToken;
  info: BackendInfo;
  source: { path: string };
}

export class ConflictError extends Error {
  constructor(public current: VersionToken, public expected: VersionToken) {
    super(`Version conflict: expected ${expected}, current ${current}`);
    this.name = "ConflictError";
  }
}

export class DuplicateError extends Error {
  constructor(public name: string) {
    super(`Duplicate: ${name}`);
    this.name = "DuplicateError";
  }
}

export class MissingNodeError extends Error {
  constructor(public name: string) {
    super(`Missing node: ${name}`);
    this.name = "MissingNodeError";
  }
}

export class MissingRelationError extends Error {
  constructor(public id: string) {
    super(`Missing relation: ${id}`);
    this.name = "MissingRelationError";
  }
}

export class MissingObservationError extends Error {
  constructor(public name: string) {
    super(`No observations matched on ${name}`);
    this.name = "MissingObservationError";
  }
}

export interface EntityPatch {
  newName?: string;
  entityType?: string;
  observations?: string[];
}

/**
 * Backend abstraction for graph-view's data plane.
 *
 * Invariants:
 *  - Every mutation returns a fresh Snapshot reflecting post-mutation state.
 *    UI never has to diff; it just applies what comes back.
 *  - `expected` mismatch throws ConflictError. Callers translate to the
 *    structured error response shape used by the MCP tool layer.
 *  - VersionToken is opaque to callers. Only equality matters.
 */
export interface Backend {
  info(): BackendInfo;

  load(): Promise<Snapshot>;
  pollVersion(): Promise<VersionToken>;

  createEntity(e: Entity, expected?: VersionToken): Promise<Snapshot>;
  updateEntity(
    name: string,
    patch: EntityPatch,
    expected?: VersionToken
  ): Promise<Snapshot>;
  deleteEntity(
    name: string,
    expected?: VersionToken
  ): Promise<{ snapshot: Snapshot; deletedRelations: number }>;

  addObservations(
    name: string,
    contents: string[],
    expected?: VersionToken
  ): Promise<{ snapshot: Snapshot; addedCount: number }>;
  deleteObservations(
    name: string,
    contents: string[],
    expected?: VersionToken
  ): Promise<Snapshot>;

  createRelation(r: Relation, expected?: VersionToken): Promise<Snapshot>;
  deleteRelation(r: Relation, expected?: VersionToken): Promise<Snapshot>;

  dispose(): Promise<void>;
}
