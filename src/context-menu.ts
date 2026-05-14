export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  separator?: boolean;
}

let currentMenu: HTMLDivElement | null = null;

function dismiss() {
  if (currentMenu) {
    currentMenu.remove();
    currentMenu = null;
  }
}

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  dismiss();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const item of items) {
    if (item.separator) {
      menu.appendChild(document.createElement("hr"));
      continue;
    }
    const btn = document.createElement("button");
    btn.textContent = item.label;
    if (item.danger) btn.classList.add("danger");
    btn.onclick = () => {
      dismiss();
      item.onClick();
    };
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);

  // Position, keep within viewport
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  menu.style.left = `${Math.min(x, vw - w - 4)}px`;
  menu.style.top = `${Math.min(y, vh - h - 4)}px`;

  currentMenu = menu;
}

document.addEventListener("click", (e) => {
  if (!currentMenu) return;
  if (e.target instanceof Node && currentMenu.contains(e.target)) return;
  dismiss();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") dismiss();
});
window.addEventListener("blur", dismiss);
window.addEventListener("resize", dismiss);
