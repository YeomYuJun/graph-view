import type { App } from "@modelcontextprotocol/ext-apps";
import { showConfirmModal, showFormModal } from "./modal.js";
import { notifyChange } from "./notify.js";
import { ServerClient } from "./server-client.js";
import { store } from "./state.js";
import { colorForType } from "./style-palette.js";
import type { Entity, MutationResult, Relation } from "./types.js";

type Toast = (msg: string, kind?: "ok" | "err") => void;
type AfterMutation = (newVersion: number) => void;
type OnConflict = (currentVersion: number) => void;

export interface SidePanelDeps {
  app: () => App | null;
  toast: Toast;
  afterMutation: AfterMutation;
  onConflict: OnConflict;
  /** Open the Create Relation modal pre-filled with the current node as `from`. */
  openConnectFrom?: (name: string) => void;
}

// Inline SVG icons used in the action row (kept small — 11px stroke icons).
const ICON_EDIT = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
const ICON_CONNECT = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="5" r="2.2"/><circle cx="19" cy="19" r="2.2"/><path d="M7 7l10 10"/></svg>`;
const ICON_DELETE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;

export function createSidePanel(deps: SidePanelDeps) {
  const bodyEl = () => document.getElementById("panel-body") as HTMLDivElement;
  const emptyEl = () => document.getElementById("panel-empty") as HTMLDivElement;

  function handle<T>(
    r: MutationResult<T>,
    okMsg: string
  ): r is { ok: true; version: number; payload: T } {
    if (r.ok) {
      deps.toast(okMsg, "ok");
      deps.afterMutation(r.version);
      return true;
    }
    if (r.code === "VERSION_CONFLICT" && r.currentVersion != null) {
      deps.onConflict(r.currentVersion);
      return false;
    }
    deps.toast(`[${r.code}] ${r.message}`, "err");
    return false;
  }

  function render(): void {
    const view = store.getView();
    const sel = view.selection;
    const body = bodyEl();
    const empty = emptyEl();
    const emptyText = empty.querySelector(".empty-text") as HTMLElement | null;
    const emptyTitle = empty.querySelector(".empty-title");

    if (sel.kind === "none") {
      body.hidden = true;
      empty.hidden = false;
      empty.classList.remove("side-panel__empty--icon-only");
      if (emptyText) emptyText.hidden = false;
      // Reset the title in case the previous render mutated it (entity-not-found case).
      if (emptyTitle) emptyTitle.textContent = "노드 또는 엣지를 선택하세요";
      return;
    }

    // Selection exists — keep the icon as a persistent header, hide the text.
    empty.hidden = false;
    empty.classList.add("side-panel__empty--icon-only");
    if (emptyText) emptyText.hidden = true;
    body.hidden = false;
    body.innerHTML = "";

    if (sel.kind === "node") {
      const entity = store.getEntity(sel.name);
      if (!entity) {
        // Entity was deleted under us — fall back to the full placeholder.
        empty.classList.remove("side-panel__empty--icon-only");
        if (emptyText) emptyText.hidden = false;
        body.hidden = true;
        if (emptyTitle) emptyTitle.textContent = "선택된 노드를 찾을 수 없습니다";
        return;
      }
      renderEntity(body, entity);
    } else {
      renderRelation(body, sel);
    }
  }

  function renderEntity(root: HTMLDivElement, e: Entity): void {
    // Title row: color-coded entity icon + name
    const titleRow = document.createElement("div");
    titleRow.className = "panel-title-row";
    const titleIcon = document.createElement("span");
    titleIcon.className = "panel-name__icon";
    titleIcon.style.background = colorForType(e.entityType);
    titleRow.appendChild(titleIcon);
    const nameEl = document.createElement("h3");
    nameEl.className = "panel-name";
    nameEl.textContent = e.name;
    titleRow.appendChild(nameEl);
    root.appendChild(titleRow);

    const typeEl = document.createElement("div");
    typeEl.className = "panel-type";
    const dot = document.createElement("span");
    dot.className = "panel-type__dot";
    dot.style.background = colorForType(e.entityType);
    const typeLabel = document.createElement("span");
    typeLabel.textContent = e.entityType;
    const sep = document.createElement("span");
    sep.className = "panel-type__sep";
    sep.textContent = "·";
    const count = document.createElement("span");
    count.className = "panel-type__count";
    count.textContent = `${e.observations.length} obs.`;
    typeEl.append(dot, typeLabel, sep, count);
    root.appendChild(typeEl);

    // Actions row sits below the type chip — Edit / Connect on the left,
    // Delete pushed to the right with a flex spacer.
    const actions = document.createElement("div");
    actions.className = "panel-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "btn btn--sm";
    editBtn.id = "panel-edit";
    editBtn.innerHTML = `${ICON_EDIT}<span>Edit</span>`;
    editBtn.onclick = () => openEditEntity(e);
    actions.appendChild(editBtn);

    const connectBtn = document.createElement("button");
    connectBtn.className = "btn btn--sm";
    connectBtn.id = "panel-connect";
    connectBtn.title = "Create relation from this node";
    connectBtn.innerHTML = `${ICON_CONNECT}<span>Connect</span>`;
    connectBtn.onclick = () => deps.openConnectFrom?.(e.name);
    actions.appendChild(connectBtn);

    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    actions.appendChild(spacer);

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn--sm btn--danger";
    delBtn.id = "panel-delete";
    delBtn.innerHTML = `${ICON_DELETE}<span>Delete</span>`;
    delBtn.onclick = () => confirmDeleteEntity(e.name);
    actions.appendChild(delBtn);

    root.appendChild(actions);

    // Observations
    const obsHead = document.createElement("div");
    obsHead.className = "panel-section";
    obsHead.innerHTML = `<span>Observations (${e.observations.length})</span>`;
    root.appendChild(obsHead);

    const obsList = document.createElement("ul");
    obsList.className = "observation-list";
    if (e.observations.length === 0) {
      const li = document.createElement("li");
      const t = document.createElement("span");
      t.className = "obs-text";
      t.style.color = "var(--fg-ghost)";
      t.textContent = "(없음)";
      li.appendChild(t);
      obsList.appendChild(li);
    } else {
      for (const obs of e.observations) {
        const li = document.createElement("li");
        const t = document.createElement("span");
        t.className = "obs-text";
        t.textContent = obs;
        li.appendChild(t);
        const del = document.createElement("button");
        del.className = "obs-del";
        del.title = "Delete observation";
        del.textContent = "✕";
        del.onclick = () => confirmDeleteObservation(e.name, obs);
        li.appendChild(del);
        obsList.appendChild(li);
      }
    }
    root.appendChild(obsList);

    // Add observation row
    const addRow = document.createElement("div");
    addRow.className = "add-obs-row";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = "new observation…";
    addRow.appendChild(inp);
    const addBtn = document.createElement("button");
    addBtn.className = "btn btn--sm";
    addBtn.textContent = "+";
    const submit = async () => {
      const v = inp.value.trim();
      if (!v) return;
      const app = deps.app();
      if (!app) return;
      const r = await ServerClient.addObservations(app, {
        name: e.name,
        contents: [v],
        expectedVersion: store.getSnapshot().version,
      });
      if (handle(r, "observation added")) {
        store.applyUpdateEntity(e.name, r.payload);
        inp.value = "";
        notifyChange({
          op: "observation_added",
          summary: `User added observation to '${e.name}': "${v}"`,
          detail: { entityName: e.name, content: v },
        });
      }
    };
    addBtn.onclick = submit;
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") submit();
    });
    addRow.appendChild(addBtn);
    root.appendChild(addRow);

    // Relations
    const { incoming, outgoing } = store.getNeighbors(e.name);
    if (outgoing.length > 0) {
      const head = document.createElement("div");
      head.className = "panel-section";
      head.textContent = `Outgoing (${outgoing.length})`;
      root.appendChild(head);
      root.appendChild(renderRelationList(outgoing, e.name, "to"));
    }
    if (incoming.length > 0) {
      const head = document.createElement("div");
      head.className = "panel-section";
      head.textContent = `Incoming (${incoming.length})`;
      root.appendChild(head);
      root.appendChild(renderRelationList(incoming, e.name, "from"));
    }

  }

  function renderRelationList(
    rels: Relation[],
    pivotName: string,
    direction: "from" | "to"
  ): HTMLElement {
    const ul = document.createElement("ul");
    ul.className = "relation-list";
    for (const r of rels) {
      const li = document.createElement("li");
      const otherName = direction === "to" ? r.to : r.from;
      const arrow = direction === "to" ? "→" : "←";
      const txt = document.createElement("span");
      txt.textContent = `${arrow} ${otherName}`;
      txt.style.cursor = "pointer";
      txt.style.color = "var(--accent)";
      txt.onclick = () => store.setSelection({ kind: "node", name: otherName });
      li.appendChild(txt);

      const t = document.createElement("span");
      t.className = "rel-type";
      t.textContent = r.relationType;
      li.appendChild(t);
      ul.appendChild(li);
    }
    return ul;
  }

  function renderRelation(
    root: HTMLDivElement,
    sel: { kind: "edge"; from: string; to: string; relationType: string }
  ): void {
    const head = document.createElement("h3");
    head.className = "panel-name";
    head.textContent = "Relation";
    root.appendChild(head);

    const block = document.createElement("div");
    block.style.background = "var(--surface-2)";
    block.style.border = "1px solid var(--border)";
    block.style.borderRadius = "4px";
    block.style.padding = "8px";
    block.style.fontSize = "12px";
    block.style.lineHeight = "1.6";
    block.style.marginTop = "8px";
    block.style.marginBottom = "8px";
    block.innerHTML =
      `<div><span style="color:var(--fg-muted)">from:</span> ${escapeHtml(sel.from)}</div>` +
      `<div><span style="color:var(--fg-muted)">to:</span> ${escapeHtml(sel.to)}</div>` +
      `<div><span style="color:var(--fg-muted)">type:</span> <span style="color:var(--accent);font-family:Geist,ui-monospace,monospace">${escapeHtml(sel.relationType)}</span></div>`;
    root.appendChild(block);

    const actions = document.createElement("div");
    actions.className = "panel-actions";
    const del = document.createElement("button");
    del.className = "btn btn--danger";
    del.textContent = "Delete Relation";
    del.onclick = () => confirmDeleteRelation(sel);
    actions.appendChild(del);
    root.appendChild(actions);
  }

  // ── Actions ──────────────────────────────────────────────

  async function deleteObservation(name: string, content: string): Promise<void> {
    const app = deps.app();
    if (!app) return;
    const r = await ServerClient.deleteObservations(app, {
      name,
      contents: [content],
      expectedVersion: store.getSnapshot().version,
    });
    if (handle(r, "observation removed")) {
      store.applyUpdateEntity(name, r.payload);
      notifyChange({
        op: "observation_deleted",
        summary: `User removed observation from '${name}': "${content}"`,
        detail: { entityName: name, content },
      });
    }
  }

  function confirmDeleteObservation(name: string, content: string): void {
    showConfirmModal({
      title: "Delete observation?",
      message: `'${content}' Observation이 삭제됩니다. 되돌릴 수 없습니다.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        await deleteObservation(name, content);
        (await import("./modal.js")).closeModal();
      },
    });
  }

  function openEditEntity(e: Entity): void {
    showFormModal({
      title: "Edit Entity",
      fields: [
        { key: "name", label: "Name", type: "text", initial: e.name },
        { key: "entityType", label: "Type", type: "text", initial: e.entityType },
        {
          key: "observations",
          label: "Observations (한 줄에 하나)",
          type: "textarea",
          initial: e.observations.join("\n"),
        },
      ],
      submitLabel: "Save",
      onSubmit: async (vals) => {
        const app = deps.app();
        if (!app) return;
        const newName = vals.name.trim();
        const newType = vals.entityType.trim();
        const newObs = vals.observations
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (!newName || !newType) {
          deps.toast("name과 type은 비울 수 없음", "err");
          return;
        }
        const r = await ServerClient.updateEntity(app, {
          name: e.name,
          newName: newName !== e.name ? newName : undefined,
          entityType: newType !== e.entityType ? newType : undefined,
          observations: newObs,
          expectedVersion: store.getSnapshot().version,
        });
        if (handle(r, "entity updated")) {
          store.applyUpdateEntity(e.name, r.payload);
          store.setSelection({ kind: "node", name: r.payload.name });
          notifyChange({
            op: "entity_updated",
            summary:
              e.name !== r.payload.name
                ? `User renamed '${e.name}' → '${r.payload.name}' (type ${r.payload.entityType})`
                : `User edited entity '${r.payload.name}'`,
            detail: { oldName: e.name, entity: r.payload },
          });
          (await import("./modal.js")).closeModal();
        }
      },
    });
  }

  function confirmDeleteEntity(name: string): void {
    showConfirmModal({
      title: "Delete entity?",
      message: `'${name}' 노드와 관련된 모든 relation이 삭제됩니다. 되돌릴 수 없습니다.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        const app = deps.app();
        if (!app) return;
        const r = await ServerClient.deleteEntity(app, {
          name,
          expectedVersion: store.getSnapshot().version,
        });
        const okMsg = r.ok
          ? `'${name}' deleted (${r.payload.deletedRelations} relations)`
          : "";
        if (handle(r, okMsg)) {
          store.applyDeleteEntity(name);
          notifyChange({
            op: "entity_deleted",
            summary: `User deleted entity '${name}' (and ${r.payload.deletedRelations} related relations)`,
            detail: { name, deletedRelations: r.payload.deletedRelations },
          });
        }
        (await import("./modal.js")).closeModal();
      },
    });
  }

  function confirmDeleteRelation(r: Relation): void {
    showConfirmModal({
      title: "Delete relation?",
      message: `'${r.from} —[${r.relationType}]→ ${r.to}' Relation이 삭제됩니다. 되돌릴 수 없습니다.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        const app = deps.app();
        if (!app) return;
        const res = await ServerClient.deleteRelation(app, {
          ...r,
          expectedVersion: store.getSnapshot().version,
        });
        if (handle(res, "relation deleted")) {
          store.applyDeleteRelation(r);
          notifyChange({
            op: "relation_deleted",
            summary: `User deleted relation '${r.from}' —[${r.relationType}]→ '${r.to}'`,
            detail: r,
          });
        }
        (await import("./modal.js")).closeModal();
      },
    });
  }

  return { render };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
