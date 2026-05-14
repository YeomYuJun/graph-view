import { closeModal } from "./modal.js";
import { sendChatRequest } from "./notify.js";
import { store } from "./state.js";

const modalEl = () => document.getElementById("modal") as HTMLDivElement;
const panelEl = () => document.getElementById("modal-panel") as HTMLDivElement;

/**
 * Find entities with zero relations (incoming + outgoing).
 */
function findOrphans(): string[] {
  const rels = store.getRelations();
  const connected = new Set<string>();
  for (const r of rels) {
    connected.add(r.from);
    connected.add(r.to);
  }
  return store
    .getEntities()
    .filter((e) => !connected.has(e.name))
    .map((e) => e.name);
}

export function openOrphanWizard(opts: {
  toast: (msg: string, kind?: "ok" | "err") => void;
}): void {
  const orphans = findOrphans();
  const m = modalEl();
  const p = panelEl();

  p.innerHTML = "";
  const title = document.createElement("h3");
  title.className = "modal__title";
  title.textContent = orphans.length
    ? `Orphan nodes — ${orphans.length} found`
    : "No orphan nodes";
  p.appendChild(title);

  if (orphans.length === 0) {
    const msg = document.createElement("p");
    msg.className = "modal__msg";
    msg.textContent = "모든 노드가 최소 한 개 이상의 관계를 가지고 있습니다.";
    p.appendChild(msg);
    appendFooter(p, [
      { label: "OK", primary: true, onClick: () => closeModal() },
    ]);
    m.hidden = false;
    return;
  }

  const desc = document.createElement("p");
  desc.className = "modal__msg";
  desc.textContent =
    "관계가 없는 노드 목록입니다. 각 노드에 대해 Claude에게 관계 제안을 요청하거나 전체 정리를 한 번에 위임할 수 있습니다.";
  p.appendChild(desc);

  const list = document.createElement("ul");
  list.style.listStyle = "none";
  list.style.padding = "0";
  list.style.margin = "0";
  list.style.maxHeight = "240px";
  list.style.overflow = "auto";
  list.style.border = "1px solid var(--border)";
  list.style.borderRadius = "4px";

  for (const name of orphans) {
    const li = document.createElement("li");
    li.style.padding = "6px 10px";
    li.style.borderBottom = "1px solid var(--border)";
    li.style.display = "flex";
    li.style.justifyContent = "space-between";
    li.style.alignItems = "center";
    li.style.fontSize = "12px";
    li.style.gap = "8px";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = name;
    nameSpan.style.flex = "1";
    nameSpan.style.cursor = "pointer";
    nameSpan.style.color = "var(--fg)";
    nameSpan.onclick = () => {
      store.setSelection({ kind: "node", name });
    };

    const askBtn = document.createElement("button");
    askBtn.className = "btn btn--sm";
    askBtn.textContent = "ask Claude";
    askBtn.onclick = async () => {
      const entity = store.getEntity(name);
      if (!entity) return;
      const prompt =
        `graph-view: '${entity.name}' 노드(타입: ${entity.entityType})가 ` +
        `메모리 그래프에서 관계가 없습니다. 다음 관찰 내용을 보고, ` +
        `현재 그래프의 다른 노드 중 연결이 적절한 것을 찾아 \`create_relation\` 도구로 관계를 만들어주세요. ` +
        `정확한 매칭이 없으면 새 노드를 만들 필요는 없습니다.\n\n` +
        `Observations:\n${entity.observations.map((o) => `  - ${o}`).join("\n") || "  (없음)"}`;
      const r = await sendChatRequest(prompt);
      if (r.ok) {
        opts.toast(`'${name}' 관계 제안 요청 전송`, "ok");
        li.style.opacity = "0.4";
        askBtn.disabled = true;
      } else {
        opts.toast(`전송 실패: ${r.error}`, "err");
      }
    };

    li.appendChild(nameSpan);
    li.appendChild(askBtn);
    list.appendChild(li);
  }
  p.appendChild(list);

  appendFooter(p, [
    { label: "Close", onClick: () => closeModal() },
    {
      label: `Ask Claude to connect all (${orphans.length})`,
      primary: true,
      onClick: async () => {
        const summary = orphans
          .map((n) => {
            const e = store.getEntity(n)!;
            const head = e.observations[0]?.slice(0, 80) ?? "(no observations)";
            return `  - ${n} (${e.entityType}): ${head}`;
          })
          .join("\n");
        const prompt =
          `graph-view: 메모리 그래프에 관계가 없는 노드가 ${orphans.length}개 있습니다. ` +
          `각 노드의 관찰 내용을 검토하고, 현재 그래프의 다른 노드 중 의미적으로 연결이 적절한 것을 찾아 ` +
          `\`create_relation\` 도구로 관계를 만들어주세요. 정확한 매칭이 없는 노드는 건너뛰어도 됩니다.\n\n` +
          `Orphan nodes:\n${summary}`;
        const r = await sendChatRequest(prompt);
        if (r.ok) {
          opts.toast(`${orphans.length}개 노드 관계 제안 요청 전송`, "ok");
          closeModal();
        } else {
          opts.toast(`전송 실패: ${r.error}`, "err");
        }
      },
    },
  ]);

  m.hidden = false;
}

function appendFooter(
  panel: HTMLDivElement,
  buttons: Array<{
    label: string;
    primary?: boolean;
    onClick: () => void;
  }>
): void {
  const foot = document.createElement("div");
  foot.className = "modal__foot";
  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.className = b.primary ? "btn btn--primary" : "btn btn--ghost";
    btn.textContent = b.label;
    btn.onclick = b.onClick;
    foot.appendChild(btn);
  }
  panel.appendChild(foot);
}
