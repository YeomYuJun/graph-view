const modalEl = () => document.getElementById("modal") as HTMLDivElement;
const panelEl = () => document.getElementById("modal-panel") as HTMLDivElement;

export interface FieldDef {
  key: string;
  label: string;
  type: "text" | "textarea";
  initial?: string;
  placeholder?: string;
  /** When provided, attaches a <datalist> for autocomplete on text inputs. */
  suggestions?: string[];
}

export function closeModal(): void {
  modalEl().hidden = true;
  panelEl().innerHTML = "";
}

/** Show or clear an inline error inside the open modal (above the footer). */
export function setModalError(msg: string | null): void {
  const p = panelEl();
  let err = p.querySelector(".modal__error") as HTMLDivElement | null;
  if (!msg) {
    err?.remove();
    return;
  }
  if (!err) {
    err = document.createElement("div");
    err.className = "modal__error";
    err.setAttribute("role", "alert");
    const foot = p.querySelector(".modal__foot");
    if (foot) p.insertBefore(err, foot);
    else p.appendChild(err);
  }
  err.textContent = msg;
}

export function showFormModal(opts: {
  title: string;
  fields: FieldDef[];
  submitLabel?: string;
  cancelLabel?: string;
  onSubmit: (values: Record<string, string>) => void | Promise<void>;
}): void {
  const m = modalEl();
  const p = panelEl();

  p.innerHTML = "";
  const title = document.createElement("h3");
  title.className = "modal__title";
  title.textContent = opts.title;
  p.appendChild(title);

  const inputs: Record<string, HTMLInputElement | HTMLTextAreaElement> = {};
  for (const f of opts.fields) {
    const wrap = document.createElement("div");
    wrap.className = "modal__field";
    const lab = document.createElement("label");
    lab.textContent = f.label;
    wrap.appendChild(lab);
    const input =
      f.type === "textarea"
        ? document.createElement("textarea")
        : document.createElement("input");
    if (input instanceof HTMLInputElement) input.type = "text";
    input.value = f.initial ?? "";
    if (f.placeholder) input.placeholder = f.placeholder;
    if (f.suggestions && f.suggestions.length > 0 && input instanceof HTMLInputElement) {
      const listId = `dl-${f.key}-${Math.random().toString(36).slice(2, 7)}`;
      const dl = document.createElement("datalist");
      dl.id = listId;
      for (const s of f.suggestions) {
        const o = document.createElement("option");
        o.value = s;
        dl.appendChild(o);
      }
      input.setAttribute("list", listId);
      wrap.appendChild(dl);
    }
    wrap.appendChild(input);
    inputs[f.key] = input;
    p.appendChild(wrap);
  }

  const foot = document.createElement("div");
  foot.className = "modal__foot";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn--ghost";
  cancelBtn.textContent = opts.cancelLabel ?? "Cancel";
  cancelBtn.onclick = () => closeModal();
  const submitBtn = document.createElement("button");
  submitBtn.className = "btn btn--primary";
  submitBtn.textContent = opts.submitLabel ?? "Save";
  submitBtn.onclick = async () => {
    const values: Record<string, string> = {};
    for (const [k, el] of Object.entries(inputs)) values[k] = el.value;
    submitBtn.disabled = true;
    try {
      await opts.onSubmit(values);
    } finally {
      submitBtn.disabled = false;
    }
  };
  foot.appendChild(cancelBtn);
  foot.appendChild(submitBtn);
  p.appendChild(foot);

  m.hidden = false;

  // Focus first input
  setTimeout(() => {
    const first = Object.values(inputs)[0];
    first?.focus();
  }, 0);
}

export function showConfirmModal(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}): void {
  const m = modalEl();
  const p = panelEl();

  p.innerHTML = "";
  const title = document.createElement("h3");
  title.className = "modal__title";
  title.textContent = opts.title;
  p.appendChild(title);

  const msg = document.createElement("p");
  msg.className = "modal__msg";
  msg.textContent = opts.message;
  p.appendChild(msg);

  const foot = document.createElement("div");
  foot.className = "modal__foot";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn--ghost";
  cancelBtn.textContent = opts.cancelLabel ?? "Cancel";
  cancelBtn.onclick = () => closeModal();
  const confirmBtn = document.createElement("button");
  confirmBtn.className = opts.danger ? "btn btn--danger" : "btn btn--primary";
  confirmBtn.textContent = opts.confirmLabel ?? "OK";
  confirmBtn.onclick = async () => {
    confirmBtn.disabled = true;
    try {
      await opts.onConfirm();
    } finally {
      confirmBtn.disabled = false;
    }
  };
  foot.appendChild(cancelBtn);
  foot.appendChild(confirmBtn);
  p.appendChild(foot);

  m.hidden = false;
}

// click outside to close
document.addEventListener("click", (e) => {
  if (e.target === modalEl()) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modalEl().hidden) closeModal();
});
