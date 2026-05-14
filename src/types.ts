export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

export type BackendKind = "anthropic-file" | "remote-memory-mirror";

export interface BackendInfo {
  kind: BackendKind;
  label: string;
  source: Record<string, string>;
  capabilities: {
    githubSync: boolean;
    metadata: boolean;
  };
}

export interface GraphSnapshot {
  entities: Entity[];
  relations: Relation[];
  version: number;
  backend: BackendInfo;
  source?: { path?: string };
  title?: string;
  layout?: "fcose" | "concentric" | "grid";
  theme?: "dark" | "light" | "auto";
  height?: number;
  /** Short capability brief — iframe pushes to LLM context on first load. */
  uiBrief?: string;
}

export type Selection =
  | { kind: "none" }
  | { kind: "node"; name: string }
  | { kind: "edge"; from: string; to: string; relationType: string };

export interface ViewState {
  selection: Selection;
  filter: string;
  entityTypeFilter: string;
  layout: "fcose" | "concentric" | "grid";
}

export type MutationResult<T = unknown> =
  | { ok: true; version: number; payload: T }
  | { ok: false; code: ErrorCode; message: string; currentVersion?: number };

export type ErrorCode =
  | "VERSION_CONFLICT"
  | "DUPLICATE_NAME"
  | "MISSING_NODE"
  | "MISSING_RELATION"
  | "MISSING_OBSERVATION"
  | "INVALID_INPUT"
  | "IO_ERROR";
