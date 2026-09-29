/** Writes text to the system clipboard; rejects on denial or absence. */
export type ClipboardWriter = (text: string) => Promise<void>;

export type CopyResult = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: 'denied' | 'unavailable' }>;

/** `null` when no clipboard API is reachable in this environment (never thrown). */
export function resolveClipboardWriter(): ClipboardWriter | null {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') return null;
  return text => clipboard.writeText(text);
}

/**
 * Copies the canonical share URL. Never claims success on failure: an absent or
 * throwing writer surfaces as `unavailable` / `denied` so the caller keeps
 * offering a selectable field instead of announcing a false "copied".
 */
export async function copyShareLink(shareUrl: string, writer: ClipboardWriter | null = resolveClipboardWriter()): Promise<CopyResult> {
  if (!writer) return { ok: false, reason: 'unavailable' };
  try {
    await writer(shareUrl);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'denied' };
  }
}
