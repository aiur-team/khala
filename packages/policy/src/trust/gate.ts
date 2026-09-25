// G-AUTOMATION seam. Automation authority is an explicit dependency that server
// composition injects; policy code never picks one itself and there is no global
// default. Hosted composition passes `CLOSED_AUTOMATION`, so every hosted `auto`
// request is refused and nothing is released automatically. Only the internal
// app's local composition may supply a bounded authority; the boundary check keeps
// that provider out of every hosted root.

import type { AutomationConfig } from './types';

/** Where automatic-release limits come from. Callers cannot pass raw limits. */
export type AutomationAuthority = Readonly<{
  approvedAutomation(): AutomationConfig | null;
}>;

/** The hosted seam: no approved automation limits. */
export function approvedAutomation(): AutomationConfig | null {
  return null;
}

/** The closed provider every hosted composition injects. */
export const CLOSED_AUTOMATION: AutomationAuthority = Object.freeze({ approvedAutomation });

export function isAutomationConfig(value: AutomationConfig | null): value is AutomationConfig {
  return value !== null && Number.isSafeInteger(value.maxCausalDepth) && value.maxCausalDepth > 0;
}

/**
 * The limits an injected authority approves, or null. Anything that is not an
 * authority, such as a raw config smuggled in by an untyped caller, stays closed.
 */
export function resolveAutomation(authority: AutomationAuthority): AutomationConfig | null {
  if (typeof authority !== 'object' || authority === null || typeof authority.approvedAutomation !== 'function') return null;
  const config = authority.approvedAutomation();
  return isAutomationConfig(config) ? config : null;
}
