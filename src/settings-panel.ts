import {
  applyEdgeLabels as applyEdgeLabelsRender,
  nodeStyleFor,
  type GraphRenderHandles,
  type NodeMode,
} from "./graph-render.js";

export type EdgeLabels = "on" | "off";

export interface Tweaks {
  theme: "dark" | "light" | "auto";
  accent: string;
  nodeStyle: NodeMode;
  edgeLabels: EdgeLabels;
}

export const DEFAULT_TWEAKS: Tweaks = {
  theme: "auto",
  accent: "#d97757",
  nodeStyle: "soft",
  edgeLabels: "on",
};

const STORAGE_KEY = "graph-view:tweaks";

export function loadTweaks(): Tweaks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TWEAKS };
    const parsed = JSON.parse(raw) as Partial<Tweaks>;
    return { ...DEFAULT_TWEAKS, ...parsed };
  } catch {
    return { ...DEFAULT_TWEAKS };
  }
}

export function saveTweaks(t: Tweaks): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
}

const SWATCHES: Array<{ label: string; hex: string }> = [
  { label: "Terracotta", hex: "#d97757" },
  { label: "Sage", hex: "#7ba582" },
  { label: "Slate", hex: "#7995c7" },
  { label: "Sand", hex: "#c79a6b" },
  { label: "Mauve", hex: "#b08aa0" },
];

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace("#", "");
  const v = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const n = parseInt(v, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function applyTheme(theme: Tweaks["theme"]): void {
  const resolved =
    theme === "auto"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  document.documentElement.setAttribute("data-theme", resolved);
}

export function applyAccent(hex: string): void {
  const root = document.documentElement.style;
  const { r, g, b } = hexToRgb(hex);
  root.setProperty("--accent", hex);
  root.setProperty("--accent-hover", hex);
  root.setProperty("--accent-soft", `rgba(${r},${g},${b},0.14)`);
  root.setProperty("--accent-line", `rgba(${r},${g},${b},0.45)`);
  root.setProperty("--cy-accent", hex);
  root.setProperty("--cy-accent-line", `rgba(${r},${g},${b},0.45)`);
  root.setProperty("--cy-accent-soft", `rgba(${r},${g},${b},0.10)`);
}

/** Re-applies accent-driven Cytoscape selectors (canvas doesn't read CSS vars). */
export function applyCyAccent(cy: GraphRenderHandles["cy"], hex: string): void {
  const { r, g, b } = hexToRgb(hex);
  const soft = `rgba(${r},${g},${b},0.55)`;
  (cy as any)
    .style()
    .selector("node:selected, node.focused")
    .style({ "border-color": hex, "border-opacity": 1 })
    .selector("node.neighbor")
    .style({ "border-color": soft, "border-opacity": 1 })
    .selector("edge.neighbor, edge:selected, edge.focused")
    .style({
      "line-color": hex,
      "target-arrow-color": hex,
      "source-arrow-color": hex,
      color: hex,
    })
    .update();
}

export function applyNodeMode(cy: GraphRenderHandles["cy"], mode: NodeMode): void {
  (cy as any).style().selector("node").style(nodeStyleFor(mode)).update();
}

export function applyEdgeLabels(
  cy: GraphRenderHandles["cy"],
  mode: EdgeLabels
): void {
  applyEdgeLabelsRender(cy, mode);
}

export interface SettingsPanelHandle {
  open: () => void;
  close: () => void;
  toggle: () => void;
  applyAll: () => void;
}

export function mountSettingsPanel(deps: {
  getGraph: () => GraphRenderHandles | null;
}): SettingsPanelHandle {
  let current = loadTweaks();
  let isOpen = false;

  const root = document.createElement("div");
  root.className = "settings-panel";
  root.id = "settings-panel";
  root.hidden = true;
  root.innerHTML = `
    <div class="settings-panel__head">
      <h4>Settings</h4>
      <button class="icon-btn settings-panel__close" type="button" aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>

    <div class="settings-panel__group" data-group="theme">
      <label>Theme</label>
      <div class="settings-toggle">
        <button type="button" data-value="dark">Dark</button>
        <button type="button" data-value="light">Light</button>
        <button type="button" data-value="auto">Auto</button>
      </div>
    </div>

    <div class="settings-panel__group" data-group="accent">
      <label>Accent</label>
      <div class="settings-swatches">
        ${SWATCHES.map(
          (s) =>
            `<button type="button" data-value="${s.hex}" title="${s.label}" style="background:${s.hex}"></button>`
        ).join("")}
      </div>
    </div>

    <div class="settings-panel__group" data-group="nodeStyle">
      <label>Node style</label>
      <div class="settings-toggle">
        <button type="button" data-value="soft">Soft</button>
        <button type="button" data-value="flat">Flat</button>
        <button type="button" data-value="ring">Ring</button>
      </div>
    </div>

    <div class="settings-panel__group" data-group="edgeLabels">
      <label>Edge labels</label>
      <div class="settings-toggle">
        <button type="button" data-value="on">On</button>
        <button type="button" data-value="off">Off</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  function syncActive(): void {
    root.querySelectorAll<HTMLElement>("[data-group]").forEach((grp) => {
      const k = grp.dataset.group as keyof Tweaks;
      const v = String((current as unknown as Record<string, unknown>)[k]);
      grp
        .querySelectorAll<HTMLButtonElement>("button[data-value]")
        .forEach((b) => {
          b.classList.toggle("is-on", b.dataset.value === v);
        });
    });
  }

  function applyAll(): void {
    applyTheme(current.theme);
    applyAccent(current.accent);
    const g = deps.getGraph();
    if (g) {
      applyNodeMode(g.cy, current.nodeStyle);
      applyEdgeLabels(g.cy, current.edgeLabels);
      applyCyAccent(g.cy, current.accent);
    }
  }

  function setTweak<K extends keyof Tweaks>(key: K, value: Tweaks[K]): void {
    current = { ...current, [key]: value };
    saveTweaks(current);
    applyAll();
    syncActive();
  }

  root.addEventListener("click", (e) => {
    e.stopPropagation();
    const closeBtn = (e.target as HTMLElement).closest(".settings-panel__close");
    if (closeBtn) {
      close();
      return;
    }
    const valBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(
      "button[data-value]"
    );
    if (!valBtn) return;
    const grpEl = valBtn.closest<HTMLElement>("[data-group]");
    if (!grpEl) return;
    const k = grpEl.dataset.group as keyof Tweaks;
    const v = valBtn.dataset.value as Tweaks[typeof k];
    setTweak(k, v);
  });

  function outsideClick(e: MouseEvent): void {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (root.contains(t)) return;
    if (t.closest("#settings-btn")) return; // settings-btn handles toggle itself
    close();
  }
  function escClose(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }

  function open(): void {
    if (isOpen) return;
    root.hidden = false;
    // Force reflow before adding class so transition runs.
    void root.offsetWidth;
    root.classList.add("is-open");
    syncActive();
    // Defer outside-click registration to the next tick so the triggering
    // click doesn't immediately close us.
    setTimeout(() => {
      document.addEventListener("click", outsideClick, true);
      document.addEventListener("keydown", escClose);
    }, 0);
    isOpen = true;
  }
  function close(): void {
    if (!isOpen) return;
    root.classList.remove("is-open");
    document.removeEventListener("click", outsideClick, true);
    document.removeEventListener("keydown", escClose);
    setTimeout(() => {
      if (!isOpen) root.hidden = true;
    }, 140);
    isOpen = false;
  }
  function toggle(): void {
    if (isOpen) close();
    else open();
  }

  // Track system color scheme for "auto" theme
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (current.theme === "auto") applyTheme("auto");
  });

  syncActive();
  return { open, close, toggle, applyAll };
}
