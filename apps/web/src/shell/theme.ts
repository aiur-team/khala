import type { ThemeChoice } from './types';

const STORAGE_KEY = 'khala.theme';
const DEFAULT_THEME: ThemeChoice = 'dark';

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isThemeChoice(value: string | null): value is ThemeChoice {
  return value === 'dark' || value === 'light';
}

/**
 * Deterministic theme resolution for a composition root to call before mount.
 * A host-provided theme always wins; otherwise a valid stored preference is
 * used, falling back to the default when storage is blocked or empty.
 */
export function resolveInitialTheme(options: { hostTheme?: ThemeChoice; storage?: ThemeStorage } = {}): ThemeChoice {
  if (options.hostTheme) return options.hostTheme;
  try {
    const stored = options.storage?.getItem(STORAGE_KEY) ?? null;
    if (isThemeChoice(stored)) return stored;
  } catch {
    return DEFAULT_THEME;
  }
  return DEFAULT_THEME;
}

/** Persists a locally chosen theme. Never call this for a host-provided theme. */
export function persistTheme(theme: ThemeChoice, storage?: ThemeStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, theme);
  } catch {
    // Blocked storage (private browsing, disabled cookies) is not a failure.
  }
}
