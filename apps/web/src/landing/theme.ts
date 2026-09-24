// Theme choice for the public splash page. With no stored choice the page
// follows prefers-color-scheme through CSS; a click stores an explicit choice
// and sets `data-theme` on <html>. `public/theme-init.js` applies the stored
// choice before first paint and must use the same key and values.

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'khala.theme';

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/** Reads a stored choice; blocked or throwing storage reads as "no choice". */
export function readStoredTheme(storage: ThemeStorage | null): Theme | null {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** Stores a choice; a refusal only means the choice lasts for this page load. */
export function storeTheme(storage: ThemeStorage | null, theme: Theme): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* the choice then lasts for this page load only */
  }
}

/** An explicit choice (the `data-theme` attribute) wins over the system preference. */
export function effectiveTheme(attribute: string | null, prefersDark: boolean): Theme {
  return isTheme(attribute) ? attribute : prefersDark ? 'dark' : 'light';
}

function safeStorage(): ThemeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Wires the toggle button. `aria-pressed` reports whether dark mode is on. */
export function wireThemeToggle(button: HTMLButtonElement, root: HTMLElement = document.documentElement): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const storage = safeStorage();
  const stored = readStoredTheme(storage);
  if (stored) root.dataset.theme = stored;

  const current = () => effectiveTheme(root.getAttribute('data-theme'), media.matches);
  const sync = () => button.setAttribute('aria-pressed', String(current() === 'dark'));
  const onClick = () => {
    const next: Theme = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    storeTheme(storage, next);
    sync();
  };

  sync();
  button.addEventListener('click', onClick);
  media.addEventListener('change', sync);
  return () => {
    button.removeEventListener('click', onClick);
    media.removeEventListener('change', sync);
  };
}
