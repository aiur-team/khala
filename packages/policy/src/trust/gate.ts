// G-AUTOMATION seam. Budget, loop limit, human triggers and offline expectations
// are an open launch decision, so every `auto` request is refused and nothing is
// released automatically. The gate decision fills in `approvedAutomation`; no
// caller can pass limits in, and no default exists anywhere else.

import type { AutomationConfig } from './types';

export function approvedAutomation(): AutomationConfig | null {
  return null;
}

export function isAutomationConfig(value: AutomationConfig | null): value is AutomationConfig {
  return value !== null && Number.isSafeInteger(value.maxCausalDepth) && value.maxCausalDepth > 0;
}
