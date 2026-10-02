// The card's single toast (`khToast`, RECREATION-SPEC §12.2): a check icon
// and a short text, shown for 1600ms.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckIcon } from './icons';

export const TOAST_MS = 1600;

type ToastState = Readonly<{ text: string; on: boolean; serial: number }>;

const ToastContext = createContext<Readonly<{ state: ToastState; show(text: string): void }> | null>(null);

export function ToastProvider({ children }: Readonly<{ children?: ReactNode }>) {
  const [state, setState] = useState<ToastState>({ text: '', on: false, serial: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((text: string) => {
    clearTimeout(timer.current);
    setState(previous => ({ text, on: true, serial: previous.serial + 1 }));
    timer.current = setTimeout(() => setState(previous => ({ ...previous, on: false })), TOAST_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const value = useMemo(() => ({ state, show }), [show, state]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

/** Shows a toast, e.g. `toast('Copied')`. */
export function useToast(): (text: string) => void {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must run inside KhalaApp');
  return context.show;
}

/** The `.kh-toast` live region; `KhalaApp` renders it once in `.kh-main`. */
export function Toast() {
  const state = useContext(ToastContext)?.state;
  return <div className={`kh-toast${state?.on ? ' on' : ''}`} role="status">
    {state?.text ? <><CheckIcon />{state.text}</> : null}
  </div>;
}
