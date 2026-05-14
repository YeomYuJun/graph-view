import type { App } from "@modelcontextprotocol/ext-apps";
import { showFormModal, closeModal, setModalError } from "./modal.js";
import { notifyChange } from "./notify.js";
import { ServerClient } from "./server-client.js";
import { store } from "./state.js";
import type { Entity, MutationResult } from "./types.js";

export interface ToolbarDeps {
  app: () => App | null;
  toast: (msg: string, kind?: "ok" | "err") => void;
  afterMutation: (newVersion: number) => void;
  onConflict: (currentVersion: number) => void;
  onLayoutChange: (layout: "fcose" | "concentric" | "grid") => void;
}

export function bindToolbar(deps: ToolbarDeps): { syncTypes: () => void } {
  const filterInp = document.getElementById("filter") as HTMLInputElement;
  const typeSel = document.getElementById("type-filter") as HTMLSelectElement;
  const layoutSel = document.getElementById("layout-select") as HTMLSelectElement;
  const addBtn = document.getElementById("add-node-btn") as HTMLButtonElement;

  let debounceId: number | undefined;
  filterInp.addEventListener("input", () => {
    window.clearTimeout(debounceId);
    debounceId = window.setTimeout(() => {
      store.setFilter(filterInp.value);
    }, 120);
  });

  typeSel.addEventListener("change", () => {
    store.setEntityTypeFilter(typeSel.value);
  });

  layoutSel.addEventListener("change", () => {
    const v = layoutSel.value as "fcose" | "concentric" | "grid";
    store.setLayout(v);
    deps.onLayoutChange(v);
  });

  addBtn.addEventListener("click", () => {
    openAddNodeModal();
  });

  function openAddNodeModal(): void {
    showFormModal({
      title: "Add Entity (Node)",
      fields: [
        { key: "name", label: "Name (unique)", type: "text", placeholder: "Alice" },
        { key: "entityType", label: "Type", type: "text", placeholder: "Person" },
        {
          key: "observations",
          label: "Observations (한 줄에 하나, 선택)",
          type: "textarea",
          placeholder: "Software engineer\nLives in Seoul",
        },
      ],
      submitLabel: "Create",
      onSubmit: async (vals) => {
        const app = deps.app();
        if (!app) return;
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
        const r: MutationResult<Entity> = await ServerClient.createEntity(app, {
          name,
          entityType,
          observations,
          expectedVersion: store.getSnapshot().version,
        });
        if (r.ok) {
          deps.toast(`'${name}' added`, "ok");
          store.applyCreateEntity(r.payload);
          store.setSelection({ kind: "node", name: r.payload.name });
          deps.afterMutation(r.version);
          notifyChange({
            op: "entity_created",
            summary: `User added entity '${r.payload.name}' (${r.payload.entityType}) via graph-view UI`,
            detail: { entity: r.payload },
          });
          closeModal();
        } else if (r.code === "VERSION_CONFLICT" && r.currentVersion != null) {
          deps.onConflict(r.currentVersion);
        } else {
          setModalError(`[${r.code}] ${r.message}`);
        }
      },
    });
  }

  function syncTypes(): void {
    const types = store.getEntityTypes();
    const current = typeSel.value;
    typeSel.innerHTML = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "all";
    typeSel.appendChild(all);
    for (const t of types) {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = t;
      typeSel.appendChild(o);
    }
    // restore if still present
    if (types.includes(current)) typeSel.value = current;
    else typeSel.value = "";
  }

  return { syncTypes };
}
