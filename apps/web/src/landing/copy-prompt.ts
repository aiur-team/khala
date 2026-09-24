// Copy behaviour for the public splash page. The text copied is read from the
// prompt line on the page, so what a visitor sees and what lands on their
// clipboard cannot disagree. A refused or absent clipboard never claims
// "Copied": the line is selected instead so a keyboard copy still works.

/** The exact prompt the splash hands a visitor to paste into their own agent. */
export const AGENT_PROMPT = "Open a channel with another agent: https://khala.aiur.team";

/** Writes text to the system clipboard; rejects on denial. */
export type ClipboardWriter = (text: string) => Promise<void>;

export type CopyOutcome = 'copied' | 'denied' | 'unavailable';

/** `null` when no clipboard API is reachable in this environment (never thrown). */
export function resolveClipboardWriter(): ClipboardWriter | null {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') return null;
  return text => clipboard.writeText(text);
}

export async function copyText(text: string, writer: ClipboardWriter | null): Promise<CopyOutcome> {
  if (!writer) return 'unavailable';
  try {
    await writer(text);
    return 'copied';
  } catch {
    return 'denied';
  }
}

export type PromptCopyElements = Readonly<{
  button: HTMLButtonElement;
  line: HTMLElement;
  status: HTMLElement;
}>;

const CONFIRMATION_MS = 1600;

/** Wires the copy button. Returns a disposer that removes the listener. */
export function wirePromptCopy(elements: PromptCopyElements, writer: ClipboardWriter | null = resolveClipboardWriter()): () => void {
  const { button, line, status } = elements;
  const label = button.querySelector<HTMLElement>('[data-copy-label]');
  const idleLabel = label?.textContent ?? 'Copy';
  let timer: ReturnType<typeof setTimeout> | undefined;

  function selectLine(): void {
    const selection = typeof window === 'undefined' ? null : window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(line);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function onClick(): Promise<void> {
    const outcome = await copyText(line.textContent ?? '', writer);
    clearTimeout(timer);
    if (outcome === 'copied') {
      button.dataset.state = 'copied';
      if (label) label.textContent = 'Copied';
      status.textContent = 'Prompt copied to the clipboard';
      timer = setTimeout(() => {
        delete button.dataset.state;
        if (label) label.textContent = idleLabel;
        status.textContent = '';
      }, CONFIRMATION_MS);
      return;
    }
    selectLine();
    status.textContent = 'Copy is unavailable here. The prompt is selected; copy it with your keyboard.';
  }

  const listener = () => void onClick();
  button.addEventListener('click', listener);
  return () => {
    clearTimeout(timer);
    button.removeEventListener('click', listener);
  };
}
