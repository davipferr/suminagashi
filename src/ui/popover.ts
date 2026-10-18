export interface Popover {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
}

/** Every popover's close(), so opening one closes the others. */
const all: Popover[] = [];

/**
 * A toolbar button + floating panel. Opens below the toolbar (whatever height it wraps to),
 * closes on Escape, on a click outside, or when another popover opens.
 */
export function popover(toggle: HTMLButtonElement, panel: HTMLElement, onOpen?: () => void): Popover {
  let isOpen = false;
  const set = (open: boolean) => {
    isOpen = open;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };

  const p: Popover = {
    get isOpen() {
      return isOpen;
    },
    open() {
      for (const other of all) if (other !== p) other.close();
      panel.style.top = `${document.querySelector('#toolbar')!.getBoundingClientRect().bottom + 8}px`;
      set(true);
      onOpen?.();
    },
    close() {
      if (isOpen) set(false);
    },
  };
  all.push(p);

  toggle.addEventListener('click', () => (isOpen ? p.close() : p.open()));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') p.close();
  });
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (isOpen && !panel.contains(t) && !toggle.contains(t)) p.close();
  });
  set(false);
  return p;
}
