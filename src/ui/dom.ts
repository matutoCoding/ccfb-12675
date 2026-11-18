// 极简组件框架：el() 创建 DOM，组件挂载到 #app
export type VNode = HTMLElement | Text | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (VNode | VNode[] | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'value') {
      (node as HTMLInputElement).value = String(v);
    } else if (k === 'html') {
      node.innerHTML = String(v);
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export interface Page {
  render(container: HTMLElement): void | Promise<void>;
  dispose?(): void;
}

export function clearNode(node: HTMLElement) {
  node.replaceChildren();
}

export function toast(msg: string, kind: 'info' | 'warn' | 'error' | 'ok' = 'info', ms = 3200) {
  const box = document.getElementById('toast-box')!;
  const t = el('div', { class: `toast toast-${kind}` }, msg);
  box.append(t);
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 300);
  }, ms);
}

export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = el('div', { class: 'modal-mask' },
      el('div', { class: 'modal' },
        el('p', {}, message),
        el('div', { class: 'modal-actions' },
          el('button', {
            class: 'btn', onclick: () => { dlg.remove(); resolve(false); },
          }, '取消'),
          el('button', {
            class: 'btn btn-danger', onclick: () => { dlg.remove(); resolve(true); },
          }, '确认'),
        ),
      ),
    );
    document.body.append(dlg);
  });
}

export function field(label: string, input: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, el('span', {}, label), input);
}

export function numInput(value: number, oninput: (v: number) => void, step = 'any'): HTMLInputElement {
  return el('input', {
    type: 'number', step, value: String(value),
    oninput: (e: Event) => oninput(parseFloat((e.target as HTMLInputElement).value) || 0),
  }) as HTMLInputElement;
}

export function textInput(value: string, oninput: (v: string) => void): HTMLInputElement {
  return el('input', {
    type: 'text', value,
    oninput: (e: Event) => oninput((e.target as HTMLInputElement).value),
  }) as HTMLInputElement;
}

export function selectInput(options: string[], value: string, onchange: (v: string) => void): HTMLSelectElement {
  const s = el('select', {
    onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value),
  }, ...options.map((o) => el('option', { value: o, selected: o === value }, o))) as HTMLSelectElement;
  return s;
}
