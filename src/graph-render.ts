import cytoscape, {
  type Core,
  type ElementDefinition,
  type EventObject,
  type NodeSingular,
  type EdgeSingular,
  type LayoutOptions,
} from "cytoscape";
// @ts-expect-error — no bundled types
import fcose from "cytoscape-fcose";
// @ts-expect-error — no bundled types
import edgehandles from "cytoscape-edgehandles";

import { relId, store } from "./state.js";
import { colorForType } from "./style-palette.js";
import type { Entity, Relation } from "./types.js";

cytoscape.use(fcose);
cytoscape.use(edgehandles);

type EdgeStartCallback = (sourceName: string, targetName: string) => void;

export type NodeMode = "soft" | "flat" | "ring";

export interface GraphRenderHandles {
  cy: Core;
  /**
   * Run the named layout. `opts.incremental: true` preserves existing node
   * positions (fcose: randomize:false; other layouts run normally) so small
   * topology changes don't reshuffle the whole graph.
   */
  runLayout: (
    name?: "fcose" | "concentric" | "grid",
    opts?: { incremental?: boolean }
  ) => void;
  refresh: () => void;
  setEdgeHandlesEnabled: (enabled: boolean) => void;
  setZoom: (level: number) => void;
  fitView: () => void;
}

/** Shared style fields that don't differ between node modes. */
const COMMON_NODE_STYLE = {
  label: "data(label)",
  color: "#f0ede5",
  "font-family": "Pretendard, ui-sans-serif, system-ui, sans-serif",
  "font-size": 11,
  "font-weight": 500,
  "text-outline-color": "#1a1815",
  "text-outline-width": 1.3,
  "text-outline-opacity": 0.8,
  "text-valign": "bottom",
  "text-halign": "center",
  "text-margin-y": 8,
  "text-wrap": "wrap",
  "text-max-width": "140",
  "transition-property":
    "background-color, background-opacity, border-color, border-width, border-opacity, opacity, width, height",
  "transition-duration": 180,
  "transition-timing-function": "ease-out",
  width: (n: NodeSingular) => {
    const obs = n.data("observationCount") ?? 0;
    return 28 + Math.min(36, obs * 6);
  },
  height: (n: NodeSingular) => {
    const obs = n.data("observationCount") ?? 0;
    return 28 + Math.min(36, obs * 6);
  },
} as const;

/** Toggle edge label visibility via opacity (keeps `label` data intact so
 *  Cytoscape's transition picks up the fade). */
export function applyEdgeLabels(cy: Core, mode: "on" | "off"): void {
  const on = mode === "on";
  (cy as any)
    .style()
    .selector("edge")
    .style({
      "text-opacity": on ? 1 : 0,
      "text-background-opacity": on ? 0.9 : 0,
      "text-border-opacity": on ? 1 : 0,
    })
    .update();
}

/** Style dict for a given node visual mode. Always declares the same property
 *  set across modes so switching doesn't leave stale values behind. */
export function nodeStyleFor(mode: NodeMode): Record<string, unknown> {
  const fill = (n: NodeSingular) => colorForType(n.data("entityType"));
  if (mode === "flat") {
    return {
      ...COMMON_NODE_STYLE,
      "background-color": fill,
      "background-opacity": 1,
      "border-width": 1,
      "border-color": fill,
      "border-opacity": 0.9,
    };
  }
  if (mode === "ring") {
    // Tinted interior (entity color at low alpha) so the ring is clearly a
    // visible "hollow but present" shape, not a hole in the canvas.
    return {
      ...COMMON_NODE_STYLE,
      "background-color": fill,
      "background-opacity": 0.15,
      "border-width": 3,
      "border-color": fill,
      "border-opacity": 1,
    };
  }
  // soft (default)
  return {
    ...COMMON_NODE_STYLE,
    "background-color": fill,
    "background-opacity": 1,
    "border-width": 8,
    "border-color": fill,
    "border-opacity": 0.22,
  };
}

export function mountGraph(opts: {
  container: HTMLElement;
  onSelectNode: (name: string) => void;
  onSelectEdge: (r: Relation) => void;
  onSelectNone: () => void;
  onNodeContextMenu: (name: string, ev: { x: number; y: number }) => void;
  onEdgeContextMenu: (r: Relation, ev: { x: number; y: number }) => void;
  onCanvasContextMenu: (ev: {
    x: number;
    y: number;
    modelX: number;
    modelY: number;
  }) => void;
  onEdgeDrawn: EdgeStartCallback;
}): GraphRenderHandles {
  const cy = cytoscape({
    container: opts.container,
    elements: [],
    // Cytoscape warns when this is not 1, but 1 feels slow on dense graphs.
    // 0.5 is a good middle ground for trackpad+wheel.
    wheelSensitivity: 0.5,
    style: [
      {
        selector: "node",
        style: nodeStyleFor("soft") as any,
      },
      {
        selector: "node:selected, node.focused",
        style: {
          "border-width": 10,
          "border-color": "#d97757",
          "border-opacity": 1,
        },
      },
      {
        selector: "node.neighbor",
        style: {
          "border-color": "rgba(217, 119, 87, 0.55)",
          "border-opacity": 1,
          "border-width": 8,
        },
      },
      {
        selector: "node.hidden",
        style: { display: "none" },
      },
      {
        selector: "edge",
        style: {
          // Fixed to straight. Self-loops are auto-promoted to a curved
          // fallback by Cytoscape, so we don't need a runtime toggle.
          "curve-style": "straight",
          "target-arrow-shape": "triangle",
          "target-arrow-color": "#6a655c",
          "line-color": "#6a655c",
          "arrow-scale": 0.9,
          width: 1.1,
          opacity: 0.55,
          label: "data(label)",
          color: "#9b9588",
          "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
          "font-size": 9,
          "text-rotation": "autorotate",
          "text-background-color": "#1a1815",
          "text-background-opacity": 0.9,
          "text-background-padding": "3px",
          "text-background-shape": "roundrectangle",
          "text-border-color": "#34312d",
          "text-border-width": 1,
          "text-border-opacity": 1,
          "transition-property":
            "line-color, target-arrow-color, source-arrow-color, opacity, width, color, text-opacity, text-background-opacity, text-border-opacity",
          "transition-duration": 180,
          "transition-timing-function": "ease-out",
        },
      },
      {
        selector: "edge.bidir",
        style: {
          "source-arrow-shape": "triangle",
          "source-arrow-color": "#6a655c",
        },
      },
      {
        selector: "edge.neighbor, edge:selected, edge.focused",
        style: {
          "line-color": "#d97757",
          "target-arrow-color": "#d97757",
          "source-arrow-color": "#d97757",
          color: "#d97757",
          width: 2,
          opacity: 1,
        },
      },
      {
        selector: "edge.hidden",
        style: { display: "none" },
      },
      // Unified dim — applied to BOTH nodes and edges that aren't in the
      // focused/neighbor set. Subtle enough to read remaining structure.
      {
        selector: ".dimmed",
        style: { opacity: 0.18 },
      },
      // edge-handles intermediate styles
      {
        selector: ".eh-handle",
        style: {
          "background-color": "#3b82f6",
          width: 10,
          height: 10,
          shape: "ellipse",
          "overlay-opacity": 0,
          "border-width": 0,
          "z-index": 9999,
        },
      },
      {
        selector: ".eh-hover",
        style: {
          "background-color": "#22c55e",
        },
      },
      {
        selector: ".eh-source",
        style: {
          "border-width": 3,
          "border-color": "#22c55e",
        },
      },
      {
        selector: ".eh-target",
        style: {
          "border-width": 3,
          "border-color": "#3b82f6",
        },
      },
      {
        selector: ".eh-preview, .eh-ghost-edge",
        style: {
          "line-color": "#3b82f6",
          "target-arrow-color": "#3b82f6",
          "source-arrow-color": "#3b82f6",
        },
      },
    ],
  });

  // ── Edge-handles for shift+drag edge creation ──
  // UX: shift held + drag from any node body = start drawing an edge.
  //     Plain drag = move node (Cytoscape default). No anchor handle needed.
  const eh = (cy as any).edgehandles({
    canConnect: (sourceNode: NodeSingular, targetNode: NodeSingular) =>
      !sourceNode.same(targetNode),
    edgeParams: () => ({ data: { _ephemeral: true } }),
    hoverDelay: 0,
    snap: true,
    // Hide the hover anchor entirely — we trigger draw programmatically.
    handleNodes: () => false,
  });

  let shiftHeld = false;
  let drawing = false;
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift") shiftHeld = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift") {
      shiftHeld = false;
      if (drawing) {
        eh.stop();
        drawing = false;
      }
    }
  });

  cy.on("mousedown", "node", (evt: EventObject) => {
    if (!shiftHeld) return;
    // Block the default node-drag and start an edge instead.
    evt.preventDefault?.();
    eh.start(evt.target);
    drawing = true;
  });

  cy.on("ehcomplete", (_evt: any, sourceNode: NodeSingular, targetNode: NodeSingular, addedEdge: EdgeSingular) => {
    drawing = false;
    // Remove ephemeral edge — the actual creation flows through the server.
    addedEdge.remove();
    opts.onEdgeDrawn(sourceNode.id(), targetNode.id());
  });
  cy.on("ehcancel", () => {
    drawing = false;
  });

  // ── Selection ──
  cy.on("tap", "node", (evt: EventObject) => {
    opts.onSelectNode(evt.target.id());
  });
  cy.on("tap", "edge", (evt: EventObject) => {
    const data = evt.target.data();
    opts.onSelectEdge({
      from: data.source,
      to: data.target,
      relationType: data.relationType,
    });
  });
  cy.on("tap", (evt: EventObject) => {
    if (evt.target === cy) opts.onSelectNone();
  });

  // ── Context menu ──
  cy.on("cxttap", "node", (evt: EventObject) => {
    const re = evt.originalEvent as MouseEvent;
    opts.onNodeContextMenu(evt.target.id(), { x: re.clientX, y: re.clientY });
  });
  cy.on("cxttap", "edge", (evt: EventObject) => {
    const re = evt.originalEvent as MouseEvent;
    const d = evt.target.data();
    opts.onEdgeContextMenu(
      { from: d.source, to: d.target, relationType: d.relationType },
      { x: re.clientX, y: re.clientY }
    );
  });
  cy.on("cxttap", (evt: EventObject) => {
    if (evt.target !== cy) return;
    const re = evt.originalEvent as MouseEvent;
    // evt.position is in cytoscape model (graph) coordinates — what node.position() expects.
    opts.onCanvasContextMenu({
      x: re.clientX,
      y: re.clientY,
      modelX: evt.position.x,
      modelY: evt.position.y,
    });
  });

  function applyNeighborhoodHighlight(): void {
    const view = store.getView();
    cy.elements().removeClass("dimmed neighbor focused");
    if (view.selection.kind === "node") {
      const node = cy.getElementById(view.selection.name);
      if (node.length === 0) return;
      // closedNeighborhood = node + connected edges + neighbor nodes.
      const neighborhood = node.closedNeighborhood();
      cy.elements().difference(neighborhood).addClass("dimmed");
      node.addClass("focused");
      // Everything else in the neighborhood (edges + nodes) becomes a neighbor.
      neighborhood.difference(node).addClass("neighbor");
    } else if (view.selection.kind === "edge") {
      const id = `${view.selection.from}|${view.selection.relationType}|${view.selection.to}`;
      const edge = cy.getElementById(id);
      if (edge.length === 0) return;
      const ends = edge.connectedNodes();
      const keep = edge.union(ends);
      cy.elements().difference(keep).addClass("dimmed");
      edge.addClass("focused");
      ends.addClass("neighbor");
    }
  }

  // ── Refresh from store ──
  function refresh(): void {
    const entities = store.getEntities();
    const relations = store.getRelations();
    const view = store.getView();

    const els: ElementDefinition[] = [];
    const visibleNames = new Set<string>();

    for (const e of entities) {
      const visible = store.isEntityVisible(e);
      if (visible) visibleNames.add(e.name);
      els.push({
        group: "nodes",
        data: {
          id: e.name,
          label: e.name,
          entityType: e.entityType,
          observationCount: e.observations.length,
          summary: e.observations[0]?.slice(0, 60) ?? "",
        },
        classes: visible ? "" : "hidden",
      });
    }

    // Bidirectional detection: if A→B and B→A with same type both exist,
    // render only one edge with arrows on both ends.
    const relKeys = new Set(relations.map((r) => `${r.from}|${r.relationType}|${r.to}`));
    const skipReverse = new Set<string>();
    for (const r of relations) {
      const fwd = `${r.from}|${r.relationType}|${r.to}`;
      const rev = `${r.to}|${r.relationType}|${r.from}`;
      if (relKeys.has(rev) && !skipReverse.has(fwd)) {
        // Keep the lexicographically smaller key, skip the other.
        if (fwd < rev) skipReverse.add(rev);
        else skipReverse.add(fwd);
      }
    }

    for (const r of relations) {
      const id = relId(r);
      if (skipReverse.has(id)) continue;
      const reciprocal = relKeys.has(`${r.to}|${r.relationType}|${r.from}`) && r.from !== r.to;
      const visible = visibleNames.has(r.from) && visibleNames.has(r.to);
      els.push({
        group: "edges",
        data: {
          id,
          source: r.from,
          target: r.to,
          relationType: r.relationType,
          label: r.relationType,
          bidir: reciprocal ? 1 : 0,
        },
        classes: (visible ? "" : "hidden") + (reciprocal ? " bidir" : ""),
      });
    }

    // Diff: remove elements not present, then merge
    const newIds = new Set(els.map((e) => e.data.id as string));
    cy.elements().forEach((el) => {
      if (!newIds.has(el.id())) el.remove();
    });
    for (const el of els) {
      const existing = cy.getElementById(el.data.id as string);
      if (existing.length === 0) {
        cy.add(el);
      } else {
        existing.data(el.data);
        const cls = (el.classes as string) ?? "";
        existing.removeClass("hidden bidir");
        if (cls.includes("hidden")) existing.addClass("hidden");
        if (cls.includes("bidir")) existing.addClass("bidir");
      }
    }

    // Selection sync
    cy.elements().unselect();
    if (view.selection.kind === "node") {
      cy.getElementById(view.selection.name).select();
    } else if (view.selection.kind === "edge") {
      cy.getElementById(
        `${view.selection.from}|${view.selection.relationType}|${view.selection.to}`
      ).select();
    }
    applyNeighborhoodHighlight();
  }

  function runLayout(
    name?: "fcose" | "concentric" | "grid",
    opts?: { incremental?: boolean }
  ): void {
    const view = store.getView();
    const layoutName = name ?? view.layout ?? "fcose";
    const incremental = opts?.incremental ?? false;
    const visible = cy.elements().not(".hidden");

    let layoutOpts: LayoutOptions;
    if (layoutName === "fcose") {
      layoutOpts = {
        name: "fcose",
        animate: true,
        animationDuration: 700,
        // randomize:true picks fresh random initial positions (good for the
        // initial layout / explicit user re-layout request). randomize:false
        // uses current node positions as seed so existing nodes stay put and
        // only new nodes settle around their connected neighbors.
        randomize: !incremental,
        quality: "proof",
        // High repulsion + long ideal edges keep components visibly distinct
        // and labels readable for the 10~50 node range typical of memory.
        nodeRepulsion: 8000,
        idealEdgeLength: 150,
        nodeSeparation: 150,
        gravity: 0.25,
        gravityRange: 4,
        // Disconnected components are tiled — generous padding here keeps
        // the orphan band from collapsing into a stack.
        packComponents: true,
        tilingPaddingVertical: 60,
        tilingPaddingHorizontal: 60,
        numIter: 2500,
      } as unknown as LayoutOptions;
    } else if (layoutName === "concentric") {
      layoutOpts = {
        name: "concentric",
        animate: true,
        minNodeSpacing: 60,
        padding: 40,
      };
    } else {
      layoutOpts = { name: "grid", animate: true, padding: 40 };
    }

    visible.layout(layoutOpts).run();
  }

  return {
    cy,
    runLayout,
    refresh,
    setEdgeHandlesEnabled: (_enabled: boolean) => {
      /* no-op: edge creation is now triggered via shift+drag, always on. */
    },
    setZoom: (level: number) => {
      const bbox = cy.elements().not(".hidden").boundingBox({});
      const cx = (bbox.x1 + bbox.x2) / 2;
      const cy_ = (bbox.y1 + bbox.y2) / 2;
      cy.zoom({ level, position: { x: cx, y: cy_ } });
    },
    fitView: () => {
      const visible = cy.elements().not(".hidden");
      cy.fit(visible.length > 0 ? visible : cy.elements(), 40);
    },
  };
}
