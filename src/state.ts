import type {
  Entity,
  GraphSnapshot,
  Relation,
  Selection,
  ViewState,
} from "./types.js";

type Listener = () => void;

const EMPTY: GraphSnapshot = {
  entities: [],
  relations: [],
  version: 0,
  backend: {
    kind: "anthropic-file",
    label: "(uninitialized)",
    source: {},
    capabilities: { githubSync: false, metadata: true },
  },
};

function relId(r: { from: string; to: string; relationType: string }): string {
  return `${r.from}|${r.relationType}|${r.to}`;
}

class Store {
  private snapshot: GraphSnapshot = EMPTY;
  private entities = new Map<string, Entity>();
  private relations = new Map<string, Relation>();
  private view: ViewState = {
    selection: { kind: "none" },
    filter: "",
    entityTypeFilter: "",
    layout: "fcose",
  };
  private listeners = new Set<Listener>();

  // ── snapshot replace ─────────────────────────────────────
  setSnapshot(s: GraphSnapshot): void {
    this.snapshot = s;
    this.entities.clear();
    for (const e of s.entities) this.entities.set(e.name, e);
    this.relations.clear();
    for (const r of s.relations) this.relations.set(relId(r), r);
    this.view = {
      selection: { kind: "none" },
      filter: "",
      entityTypeFilter: "",
      layout: s.layout ?? this.view.layout,
    };
    this.emit();
  }

  setVersion(v: number): void {
    this.snapshot = { ...this.snapshot, version: v };
    // do not emit — internal bookkeeping
  }

  // ── reads ────────────────────────────────────────────────
  getSnapshot(): GraphSnapshot { return this.snapshot; }
  getView(): ViewState { return this.view; }
  getEntities(): Entity[] { return Array.from(this.entities.values()); }
  getRelations(): Relation[] { return Array.from(this.relations.values()); }
  getEntity(name: string): Entity | undefined { return this.entities.get(name); }
  getNeighbors(name: string): { incoming: Relation[]; outgoing: Relation[] } {
    const incoming: Relation[] = [];
    const outgoing: Relation[] = [];
    for (const r of this.relations.values()) {
      if (r.from === name) outgoing.push(r);
      if (r.to === name) incoming.push(r);
    }
    return { incoming, outgoing };
  }

  getEntityTypes(): string[] {
    const set = new Set<string>();
    for (const e of this.entities.values()) set.add(e.entityType);
    return Array.from(set).sort();
  }

  // ── mutations (local only — server is authoritative) ────
  applyCreateEntity(e: Entity): void {
    this.entities.set(e.name, e);
    this.emit();
  }
  applyUpdateEntity(oldName: string, e: Entity): void {
    if (oldName !== e.name) {
      this.entities.delete(oldName);
      // rewrite relations pointing at oldName
      const updated: Relation[] = [];
      for (const r of this.relations.values()) {
        if (r.from === oldName || r.to === oldName) {
          this.relations.delete(relId(r));
          const next = {
            ...r,
            from: r.from === oldName ? e.name : r.from,
            to: r.to === oldName ? e.name : r.to,
          };
          this.relations.set(relId(next), next);
          updated.push(next);
        }
      }
    }
    this.entities.set(e.name, e);
    this.emit();
  }
  applyDeleteEntity(name: string): void {
    this.entities.delete(name);
    for (const r of Array.from(this.relations.values())) {
      if (r.from === name || r.to === name) this.relations.delete(relId(r));
    }
    if (this.view.selection.kind === "node" && this.view.selection.name === name) {
      this.view.selection = { kind: "none" };
    }
    this.emit();
  }
  applyCreateRelation(r: Relation): void {
    this.relations.set(relId(r), r);
    this.emit();
  }
  applyDeleteRelation(r: Relation): void {
    this.relations.delete(relId(r));
    if (
      this.view.selection.kind === "edge" &&
      this.view.selection.from === r.from &&
      this.view.selection.to === r.to &&
      this.view.selection.relationType === r.relationType
    ) {
      this.view.selection = { kind: "none" };
    }
    this.emit();
  }

  // ── view ────────────────────────────────────────────────
  setSelection(sel: Selection): void {
    this.view.selection = sel;
    this.emit();
  }
  setFilter(s: string): void {
    this.view.filter = s;
    this.emit();
  }
  setEntityTypeFilter(t: string): void {
    this.view.entityTypeFilter = t;
    this.emit();
  }
  setLayout(l: ViewState["layout"]): void {
    this.view.layout = l;
    this.emit();
  }

  // ── derived: visibility per filter ──────────────────────
  isEntityVisible(e: Entity): boolean {
    const { filter, entityTypeFilter } = this.view;
    if (entityTypeFilter && e.entityType !== entityTypeFilter) return false;
    if (filter) {
      const needle = filter.toLowerCase();
      const hay =
        e.name.toLowerCase() +
        "\n" +
        e.entityType.toLowerCase() +
        "\n" +
        e.observations.join("\n").toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  }

  // ── subscribe ───────────────────────────────────────────
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const store = new Store();
export { relId };
