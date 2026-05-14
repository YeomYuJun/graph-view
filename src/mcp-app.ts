import { App } from "@modelcontextprotocol/ext-apps";
type HostCtx = NonNullable<ReturnType<App["getHostContext"]>>;
import { openOrphanWizard } from "./cleanup-wizard.js";
import { mountGraph } from "./graph-render.js";
import { colorForType } from "./style-palette.js";
;(window as any).colorForType = colorForType;
import { showConfirmModal, showFormModal, closeModal, setModalError } from "./modal.js";
import { notifyChange, setApp } from "./notify.js";
import { ServerClient } from "./server-client.js";
import { createSidePanel } from "./side-panel.js";
import {
  applyAccent,
  applyTheme as applyTweakTheme,
  loadTweaks,
  mountSettingsPanel,
} from "./settings-panel.js";
import { store } from "./state.js";
import { bindToolbar } from "./toolbar.js";
import { showContextMenu } from "./context-menu.js";
import type { GraphSnapshot } from "./types.js";

const titleEl = () => document.getElementById("title") as HTMLSpanElement;
const metaEl = () => document.getElementById("meta") as HTMLSpanElement;
const emptyEl = () => document.getElementById("empty") as HTMLDivElement;
const backendEl = () => document.getElementById("backend") as HTMLElement;
const versionEl = () => document.getElementById("version") as HTMLElement;
const toastEl = () => document.getElementById("toast") as HTMLSpanElement;
const reloadBtn = () => document.getElementById("reload-btn") as HTMLButtonElement;
const fullscreenBtn = () =>
  document.getElementById("fullscreen-btn") as HTMLButtonElement;
const cyContainer = () => document.getElementById("cy") as HTMLDivElement;
const cleanupBtn = () =>
  document.getElementById("cleanup-btn") as HTMLButtonElement;
const filterInput = () => document.getElementById("filter") as HTMLInputElement;

let appRef: App | null = null;

function getApp(): App | null {
  return appRef;
}

function toast(msg: string, kind: "ok" | "err" = "ok"): void {
  const el = toastEl();
  el.textContent = msg;
  el.classList.remove("toast--show", "toast--error");
  el.classList.add(kind === "err" ? "toast--error" : "toast--show");
  window.setTimeout(() => {
    el.classList.remove("toast--show", "toast--error");
    el.textContent = "";
  }, 3500);
}

function applyTheme(theme?: "dark" | "light" | "auto"): void {
  applyTweakTheme(theme ?? "auto");
}

function applyHostStyles(ctx: HostCtx): void {
  // Host theme override is honored only when user hasn't picked an explicit
  // theme in Settings (i.e. tweaks.theme === "auto").
  if (ctx.theme && loadTweaks().theme === "auto") applyTheme(ctx.theme);
  if (ctx.styles?.variables) {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(ctx.styles.variables)) {
      if (v !== undefined) root.style.setProperty(k, v as string);
    }
  }
  // Show fullscreen button only when host supports it.
  const modes = (ctx as { availableDisplayModes?: string[] }).availableDisplayModes;
  if (modes && modes.includes("fullscreen")) {
    fullscreenBtn().hidden = false;
  }
  // Reflect current display mode on root for CSS variant.
  const dm = (ctx as { displayMode?: string }).displayMode;
  if (dm) document.documentElement.setAttribute("data-display-mode", dm);
}

async function toggleFullscreen(): Promise<void> {
  if (!appRef) return;
  const root = document.documentElement;
  const current = root.getAttribute("data-display-mode") ?? "inline";
  const next = current === "fullscreen" ? "inline" : "fullscreen";
  try {
    const result = await appRef.requestDisplayMode({ mode: next });
    root.setAttribute("data-display-mode", result.mode);
  } catch (e) {
    toast(`fullscreen unsupported: ${(e as Error).message}`, "err");
  }
}

function updateMeta(): void {
  const snap = store.getSnapshot();
  const totalNodes = store.getEntities().length;
  const totalEdges = store.getRelations().length;
  metaEl().textContent = `${totalNodes} nodes · ${totalEdges} relations`;
  backendEl().textContent = snap.backend.label;
  backendEl().setAttribute("data-kind", snap.backend.kind);
  if (snap.backend.kind === "remote-memory-mirror") {
    backendEl().setAttribute(
      "title",
      "Remote-memory mirror. Local edits do NOT auto-push to GitHub. Ask Claude to call remote-memory.sync_push/sync_pull when you want to sync."
    );
  } else {
    backendEl().removeAttribute("title");
  }
  versionEl().textContent = String(snap.version);
}

let graph: ReturnType<typeof mountGraph> | null = null;
let sidePanel: ReturnType<typeof createSidePanel> | null = null;
let toolbarSync: { syncTypes: () => void } | null = null;

function afterMutation(newVersion: number): void {
  store.setVersion(newVersion);
  updateMeta();
  toolbarSync?.syncTypes();
}

function handleConflict(currentVersion: number): void {
  showConfirmModal({
    title: "External change detected",
    message:
      `메모리 그래프가 외부(LLM 또는 다른 도구)에서 변경되었습니다.\n\n` +
      `현재 버전: ${currentVersion}\n` +
      `내 버전: ${store.getSnapshot().version}\n\n` +
      `[Reload]를 누르면 디스크 상태로 새로고침하고 진행 중인 편집은 폐기됩니다.`,
    confirmLabel: "Reload",
    onConfirm: async () => {
      closeModal();
      await reloadFromServer();
    },
  });
}

async function reloadFromServer(verbose = true): Promise<void> {
  if (!appRef) return;
  const snap = await ServerClient.reload(appRef);
  if (snap) {
    applySnapshot(snap);
    if (verbose) toast("reloaded from disk", "ok");
  } else if (verbose) {
    toast("reload failed", "err");
  }
}

// ── Auto-refresh: poll for external mtime changes ─────────────────────────
// Cheap: server returns full snapshot but file read is sub-millisecond.
// Skip when a modal is open (user is mid-edit) to avoid disruption.
let autoRefreshTimer: number | undefined;
const AUTO_REFRESH_INTERVAL_MS = 5000;
let autoRefreshInFlight = false;

function isModalOpen(): boolean {
  const m = document.getElementById("modal");
  return !!m && !m.hidden;
}

async function autoRefreshTick(): Promise<void> {
  if (autoRefreshInFlight) return;
  if (isModalOpen()) return; // never interrupt mid-edit
  if (!appRef) return;
  autoRefreshInFlight = true;
  try {
    const snap = await ServerClient.reload(appRef);
    if (!snap) return;
    // Only apply if the disk version actually changed.
    if (snap.version === store.getSnapshot().version) return;
    applySnapshot(snap);
    toast(`auto-refreshed (${snap.entities.length} nodes)`, "ok");
  } catch (e) {
    console.warn("[graph-view] auto-refresh error:", e);
  } finally {
    autoRefreshInFlight = false;
  }
}

function startAutoRefresh(): void {
  stopAutoRefresh();
  autoRefreshTimer = window.setInterval(
    autoRefreshTick,
    AUTO_REFRESH_INTERVAL_MS
  );
}

function stopAutoRefresh(): void {
  if (autoRefreshTimer != null) {
    window.clearInterval(autoRefreshTimer);
    autoRefreshTimer = undefined;
  }
}

let didPushUiBrief = false;

function syncEmptyPlaceholder(): void {
  // Single source of truth: show "그래프 비어있음" only when 0 entities total.
  emptyEl().hidden = store.getEntities().length > 0;
}

function applySnapshot(snap: GraphSnapshot): void {
  // Capture pre-mutation topology so we can decide between full / incremental /
  // no layout. Without this, every auto-refresh tick that detects a single-byte
  // memory.json change would reshuffle the entire graph via a fresh fcose pass.
  const prevNodes = new Set(store.getEntities().map((e) => e.name));
  const prevEdges = new Set(
    store.getRelations().map((r) => `${r.from}|${r.relationType}|${r.to}`)
  );
  const wasEmpty = prevNodes.size === 0;

  store.setSnapshot(snap);
  titleEl().textContent = snap.title ?? "Memory Graph";
  // Server-provided theme is treated like host context: only applied when the
  // user has not picked an explicit theme in Settings.
  if (snap.theme && loadTweaks().theme === "auto") applyTheme(snap.theme);
  // Push the UI capability brief to the LLM exactly once per iframe session.
  if (!didPushUiBrief && snap.uiBrief) {
    didPushUiBrief = true;
    notifyChange({
      op: "graph_view_ready",
      summary: snap.uiBrief,
      detail: {
        version: snap.version,
        backend: snap.backend,
        nodeCount: snap.entities.length,
        relationCount: snap.relations.length,
      },
    });
  }
  if (snap.height && snap.height > 0) {
    document.documentElement.style.setProperty(
      "--app-height",
      `${snap.height}px`
    );
    // Push notification immediately so host can grow without waiting for ResizeObserver tick.
    appRef?.sendSizeChanged({ height: snap.height }).catch(() => {});
  }
  updateMeta();
  if (graph) {
    graph.refresh();
    if (wasEmpty) {
      // Initial population — full layout from randomized positions.
      setTimeout(() => graph?.runLayout(), 0);
    } else {
      const nextNodes = new Set(snap.entities.map((e) => e.name));
      const nextEdges = new Set(
        snap.relations.map((r) => `${r.from}|${r.relationType}|${r.to}`)
      );
      if (!setsEqual(prevNodes, nextNodes) || !setsEqual(prevEdges, nextEdges)) {
        // Topology changed (nodes/edges added or removed). Incremental layout
        // seeds from current positions so existing nodes stay put.
        setTimeout(
          () => graph?.runLayout(undefined, { incremental: true }),
          0
        );
      }
      // Pure data change (observations / types / labels) — skip layout entirely.
    }
  }
  toolbarSync?.syncTypes();
  syncEmptyPlaceholder();
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function getKnownRelationTypes(): string[] {
  const types = new Set<string>();
  for (const r of store.getRelations()) types.add(r.relationType);
  // Suggest structural types even if unused yet — they unlock hierarchical view.
  ["contains", "part_of", "is_a", "has_a", "depends_on", "uses", "works_at"].forEach(
    (t) => types.add(t)
  );
  return Array.from(types).sort();
}

function openCreateRelationModal(prefill: { from?: string; to?: string } = {}): void {
  const names = store.getEntities().map((e) => e.name).sort();
  if (names.length < 2) {
    toast("관계를 만들려면 노드가 2개 이상 필요합니다", "err");
    return;
  }
  showFormModal({
    title: "Create Relation",
    fields: [
      {
        key: "from",
        label: "From (시작 노드)",
        type: "text",
        initial: prefill.from ?? "",
        suggestions: names,
        placeholder: names[0],
      },
      {
        key: "to",
        label: "To (대상 노드)",
        type: "text",
        initial: prefill.to ?? "",
        suggestions: names,
        placeholder: names[1] ?? "",
      },
      {
        key: "relationType",
        label: "Type (예: works_at, uses, contains)",
        type: "text",
        suggestions: getKnownRelationTypes(),
        placeholder: "works_at",
      },
    ],
    submitLabel: "Create",
    onSubmit: async (vals) => {
      if (!appRef) return;
      const from = vals.from.trim();
      const to = vals.to.trim();
      const relationType = vals.relationType.trim();
      if (!from || !to || !relationType) {
        toast("모든 필드 필수", "err");
        return;
      }
      if (from === to) {
        toast("자기 자신과는 관계 못 만듬", "err");
        return;
      }
      const r = await ServerClient.createRelation(appRef, {
        from,
        to,
        relationType,
        expectedVersion: store.getSnapshot().version,
      });
      if (r.ok) {
        toast("relation created", "ok");
        store.applyCreateRelation(r.payload);
        afterMutation(r.version);
        notifyChange({
          op: "relation_created",
          summary: `User connected '${r.payload.from}' —[${r.payload.relationType}]→ '${r.payload.to}'`,
          detail: r.payload,
        });
        closeModal();
      } else if (r.code === "VERSION_CONFLICT" && r.currentVersion != null) {
        handleConflict(r.currentVersion);
      } else {
        toast(`[${r.code}] ${r.message}`, "err");
      }
    },
  });
}

async function promptCreateRelation(sourceName: string, targetName: string): Promise<void> {
  if (!appRef) return;
  showFormModal({
    title: "Create Relation",
    fields: [
      {
        key: "relationType",
        label: `Relation type (${sourceName} → ${targetName})`,
        type: "text",
        placeholder: "works_at",
      },
    ],
    submitLabel: "Create",
    onSubmit: async (vals) => {
      const relationType = vals.relationType.trim();
      if (!relationType) {
        toast("relationType 필수", "err");
        return;
      }
      const r = await ServerClient.createRelation(appRef!, {
        from: sourceName,
        to: targetName,
        relationType,
        expectedVersion: store.getSnapshot().version,
      });
      if (r.ok) {
        toast("relation created", "ok");
        store.applyCreateRelation(r.payload);
        afterMutation(r.version);
        notifyChange({
          op: "relation_created",
          summary: `User connected '${r.payload.from}' —[${r.payload.relationType}]→ '${r.payload.to}'`,
          detail: r.payload,
        });
        closeModal();
      } else if (r.code === "VERSION_CONFLICT" && r.currentVersion != null) {
        handleConflict(r.currentVersion);
      } else {
        toast(`[${r.code}] ${r.message}`, "err");
      }
    },
  });
}

function openAddNodeAtCanvas(pos?: { x: number; y: number }): void {
  showFormModal({
    title: "Add Entity (Node)",
    fields: [
      { key: "name", label: "Name (unique)", type: "text", placeholder: "Alice" },
      { key: "entityType", label: "Type", type: "text", placeholder: "Person" },
      {
        key: "observations",
        label: "Observations (선택)",
        type: "textarea",
        placeholder: "한 줄에 하나",
      },
    ],
    submitLabel: "Create",
    onSubmit: async (vals) => {
      if (!appRef) return;
      const name = vals.name.trim();
      const entityType = vals.entityType.trim();
      if (!name || !entityType) {
        setModalError("Name과 Type은 필수입니다.");
        return;
      }
      setModalError(null);
      const observations = vals.observations
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const r = await ServerClient.createEntity(appRef, {
        name,
        entityType,
        observations,
        expectedVersion: store.getSnapshot().version,
      });
      if (r.ok) {
        toast(`'${name}' added`, "ok");
        store.applyCreateEntity(r.payload);
        // Place the new node at the right-click location (model coords).
        if (pos && graph) {
          const node = graph.cy.getElementById(r.payload.name);
          if (node.length > 0) node.position(pos);
        }
        store.setSelection({ kind: "node", name: r.payload.name });
        afterMutation(r.version);
        notifyChange({
          op: "entity_created",
          summary: `User added entity '${r.payload.name}' (${r.payload.entityType}) via canvas`,
          detail: { entity: r.payload },
        });
        closeModal();
      } else if (r.code === "VERSION_CONFLICT" && r.currentVersion != null) {
        handleConflict(r.currentVersion);
      } else {
        setModalError(`[${r.code}] ${r.message}`);
      }
    },
  });
}

function confirmDeleteEntity(name: string): void {
  showConfirmModal({
    title: "Delete entity?",
    message: `'${name}' 노드와 모든 관련 relation이 삭제됩니다.`,
    confirmLabel: "Delete",
    danger: true,
    onConfirm: async () => {
      if (!appRef) return;
      const r = await ServerClient.deleteEntity(appRef, {
        name,
        expectedVersion: store.getSnapshot().version,
      });
      if (r.ok) {
        toast(`'${name}' deleted`, "ok");
        store.applyDeleteEntity(name);
        afterMutation(r.version);
        notifyChange({
          op: "entity_deleted",
          summary: `User deleted entity '${name}' (and ${r.payload.deletedRelations} related relations)`,
          detail: { name, deletedRelations: r.payload.deletedRelations },
        });
      } else if (r.code === "VERSION_CONFLICT" && r.currentVersion != null) {
        handleConflict(r.currentVersion);
      } else {
        toast(`[${r.code}] ${r.message}`, "err");
      }
      closeModal();
    },
  });
}

// ── boot ────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  // Apply persisted theme + accent BEFORE mounting graph so header / side-panel
  // render with the correct colors on the first frame.
  const initialTweaks = loadTweaks();
  applyTheme(initialTweaks.theme);
  applyAccent(initialTweaks.accent);

  const app = new App({ name: "graph-view", version: "0.1.0" });
  appRef = app;
  setApp(app);

  app.onhostcontextchanged = (ctx) => applyHostStyles(ctx);

  app.ontoolresult = (result) => {
    const sc = (result as { structuredContent?: unknown }).structuredContent;
    if (sc && typeof sc === "object" && "entities" in sc) {
      applySnapshot(sc as GraphSnapshot);
    }
  };

  await app.connect();
  try {
    const ctx = app.getHostContext();
    if (ctx) applyHostStyles(ctx);
  } catch {
    /* ignore — older hosts */
  }

  // Mount graph
  graph = mountGraph({
    container: cyContainer(),
    onSelectNode: (name) => store.setSelection({ kind: "node", name }),
    onSelectEdge: (r) => store.setSelection({ kind: "edge", ...r }),
    onSelectNone: () => store.setSelection({ kind: "none" }),
    onNodeContextMenu: (name, p) => {
      showContextMenu(p.x, p.y, [
        { label: "Add observation…", onClick: () => store.setSelection({ kind: "node", name }) },
        { separator: true, label: "", onClick: () => {} },
        { label: "Delete node", danger: true, onClick: () => confirmDeleteEntity(name) },
      ]);
    },
    onEdgeContextMenu: (r, p) => {
      showContextMenu(p.x, p.y, [
        {
          label: "Delete relation",
          danger: true,
          onClick: () =>
            showConfirmModal({
              title: "Delete relation?",
              message: `${r.from} —[${r.relationType}]→ ${r.to}`,
              confirmLabel: "Delete",
              danger: true,
              onConfirm: async () => {
                if (!appRef) return;
                const res = await ServerClient.deleteRelation(appRef, {
                  ...r,
                  expectedVersion: store.getSnapshot().version,
                });
                if (res.ok) {
                  toast("relation deleted", "ok");
                  store.applyDeleteRelation(r);
                  afterMutation(res.version);
                  notifyChange({
                    op: "relation_deleted",
                    summary: `User deleted relation '${r.from}' —[${r.relationType}]→ '${r.to}'`,
                    detail: r,
                  });
                } else if (
                  res.code === "VERSION_CONFLICT" &&
                  res.currentVersion != null
                ) {
                  handleConflict(res.currentVersion);
                } else {
                  toast(`[${res.code}] ${res.message}`, "err");
                }
                closeModal();
              },
            }),
        },
      ]);
    },
    onCanvasContextMenu: (p) => {
      showContextMenu(p.x, p.y, [
        {
          label: "Add node here…",
          onClick: () => openAddNodeAtCanvas({ x: p.modelX, y: p.modelY }),
        },
      ]);
    },
    onEdgeDrawn: (src, tgt) => promptCreateRelation(src, tgt),
  });
  graph.setEdgeHandlesEnabled(true);

  sidePanel = createSidePanel({
    app: getApp,
    toast,
    afterMutation,
    onConflict: handleConflict,
    openConnectFrom: (name) => openCreateRelationModal({ from: name }),
  });
  toolbarSync = bindToolbar({
    app: getApp,
    toast,
    afterMutation,
    onConflict: handleConflict,
    onLayoutChange: (l) => graph?.runLayout(l),
  });

  // Wire reload + fullscreen buttons
  reloadBtn().addEventListener("click", () => reloadFromServer());
  startAutoRefresh();
  window.addEventListener("beforeunload", stopAutoRefresh);
  fullscreenBtn().addEventListener("click", () => toggleFullscreen());
  cleanupBtn().addEventListener("click", () => openOrphanWizard({ toast }));
  const addRelBtn = document.getElementById("add-rel-btn") as HTMLButtonElement | null;
  addRelBtn?.addEventListener("click", () => {
    const sel = store.getView().selection;
    openCreateRelationModal(sel.kind === "node" ? { from: sel.name } : {});
  });

  // Zoom presets
  document.querySelectorAll<HTMLButtonElement>("[data-zoom]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lvl = Number(btn.dataset.zoom);
      if (!isNaN(lvl) && graph) graph.setZoom(lvl);
    });
  });
  const zoomFitBtn = document.getElementById("zoom-fit") as HTMLButtonElement | null;
  zoomFitBtn?.addEventListener("click", () => graph?.fitView());

  // Keyboard shortcuts (global)
  document.addEventListener("keydown", (e) => {
    // Don't capture while typing in inputs / textareas / contenteditable.
    const target = e.target as HTMLElement | null;
    const inField =
      !!target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);

    // Ctrl/Cmd+F → focus search filter
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      filterInput().focus();
      filterInput().select();
      return;
    }

    if (inField) return;

    // Escape: deselect
    if (e.key === "Escape") {
      store.setSelection({ kind: "none" });
      return;
    }

    // Delete / Backspace: delete selected entity or relation
    if (e.key === "Delete" || e.key === "Backspace") {
      const sel = store.getView().selection;
      if (sel.kind === "node") {
        confirmDeleteEntity(sel.name);
      } else if (sel.kind === "edge") {
        showConfirmModal({
          title: "Delete relation?",
          message: `${sel.from} —[${sel.relationType}]→ ${sel.to}`,
          confirmLabel: "Delete",
          danger: true,
          onConfirm: async () => {
            if (!appRef) return;
            const res = await ServerClient.deleteRelation(appRef, {
              from: sel.from,
              to: sel.to,
              relationType: sel.relationType,
              expectedVersion: store.getSnapshot().version,
            });
            if (res.ok) {
              toast("relation deleted", "ok");
              store.applyDeleteRelation({
                from: sel.from,
                to: sel.to,
                relationType: sel.relationType,
              });
              afterMutation(res.version);
              notifyChange({
                op: "relation_deleted",
                summary: `User deleted relation '${sel.from}' —[${sel.relationType}]→ '${sel.to}'`,
                detail: {
                  from: sel.from,
                  to: sel.to,
                  relationType: sel.relationType,
                },
              });
            } else if (
              res.code === "VERSION_CONFLICT" &&
              res.currentVersion != null
            ) {
              handleConflict(res.currentVersion);
            } else {
              toast(`[${res.code}] ${res.message}`, "err");
            }
            closeModal();
          },
        });
      }
      return;
    }

    // 'n' → add new node
    if (e.key === "n" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      openAddNodeAtCanvas();
      return;
    }
  });

  
  const zoomInBtn = document.getElementById("zoom-in") as HTMLButtonElement | null;
  const zoomOutBtn = document.getElementById("zoom-out") as HTMLButtonElement | null;
  const zoomLevelEl = document.getElementById("zoom-level") as HTMLElement | null;
  function updateZoomHUD(): void {
    if (!graph || !zoomLevelEl) return;
    zoomLevelEl.textContent = Math.round(graph.cy.zoom() * 100) + "%";
  }
  zoomInBtn?.addEventListener("click", () => { if (graph) { graph.setZoom(graph.cy.zoom() * 1.2); updateZoomHUD(); } });
  zoomOutBtn?.addEventListener("click", () => { if (graph) { graph.setZoom(graph.cy.zoom() / 1.2); updateZoomHUD(); } });
  graph?.cy.on("zoom", updateZoomHUD);
  updateZoomHUD();

  // Active state for zoom presets
  document.querySelectorAll<HTMLButtonElement>("[data-zoom]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll<HTMLButtonElement>("[data-zoom]")
        .forEach((b) => b.classList.toggle("is-active", b === btn));
    });
  });

  // Legend rendering (bottom-left), refreshes on every store change.
  const legendRows = document.getElementById("legend-rows") as HTMLDivElement | null;
  function renderLegend(): void {
    if (!legendRows) return;
    const counts = new Map<string, number>();
    for (const e of store.getEntities()) counts.set(e.entityType, (counts.get(e.entityType) ?? 0) + 1);
    const types = Array.from(counts.keys()).sort();
    legendRows.innerHTML = "";
    for (const t of types) {
      const row = document.createElement("div");
      row.className = "legend__row";
      const color = (window as any).colorForType ? (window as any).colorForType(t) : "#9b9588";
      row.innerHTML = `<span class="legend__dot" style="background:${color}"></span><span class="legend__label" title="${t}">${t}</span><span class="legend__count">${counts.get(t)}</span>`;
      legendRows.appendChild(row);
    }
  }
  // expose for periodic re-render
  store.subscribe(() => renderLegend());
  renderLegend();

  // Subscribe — re-render on every change
  store.subscribe(() => {
    graph?.refresh();
    sidePanel?.render();
    syncEmptyPlaceholder();
  });

  // ── Settings popover ─────────────────────────────────────────────────────
  const settingsPanel = mountSettingsPanel({ getGraph: () => graph });
  // Apply user-saved tweaks now that Cytoscape is mounted.
  settingsPanel.applyAll();
  const settingsBtn = document.getElementById(
    "settings-btn"
  ) as HTMLButtonElement | null;
  settingsBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    settingsPanel.toggle();
  });

  // ── Side-panel resizer ───────────────────────────────────────────────────
  bindResizer();

  // Restore persisted side-panel width
  const savedW = Number(localStorage.getItem("graph-view:side-w") || 0);
  if (savedW >= 240 && savedW <= 720) {
    document.documentElement.style.setProperty("--side-w", `${savedW}px`);
  }

  // Initial render
  updateMeta();
  sidePanel.render();
  toolbarSync.syncTypes();
  syncEmptyPlaceholder();
}

function bindResizer(): void {
  const handle = document.getElementById("resizer");
  if (!handle) return;
  const MIN = 240;
  const MAX = 720;
  const DEFAULT = 360;

  let startX = 0;
  let startW = DEFAULT;
  let active = false;

  const onMove = (e: PointerEvent) => {
    if (!active) return;
    const dx = startX - e.clientX; // dragging left grows the panel
    const next = Math.min(MAX, Math.max(MIN, startW + dx));
    document.documentElement.style.setProperty("--side-w", `${next}px`);
    graph?.cy.resize();
  };
  const onUp = () => {
    if (!active) return;
    active = false;
    handle.classList.remove("is-active");
    document.documentElement.classList.remove("is-resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    const w = getComputedStyle(document.documentElement).getPropertyValue("--side-w").trim();
    const num = Number(w.replace("px", ""));
    if (!Number.isNaN(num)) localStorage.setItem("graph-view:side-w", String(Math.round(num)));
    graph?.cy.resize();
  };

  handle.addEventListener("pointerdown", (e) => {
    active = true;
    startX = e.clientX;
    const cur = getComputedStyle(document.documentElement).getPropertyValue("--side-w").trim();
    const parsed = Number(cur.replace("px", ""));
    startW = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT;
    handle.classList.add("is-active");
    document.documentElement.classList.add("is-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  handle.addEventListener("dblclick", () => {
    document.documentElement.style.removeProperty("--side-w");
    localStorage.removeItem("graph-view:side-w");
    graph?.cy.resize();
  });
}

boot().catch((err) => {
  console.error("[graph-view] boot failed:", err);
  toast(`boot failed: ${err?.message ?? err}`, "err");
});
