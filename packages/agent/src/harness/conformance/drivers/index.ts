import type { FakeHarnessDriver } from '../driver';
import { claudeDriver } from './claude';
import { codexDriver } from './codex';
import { genericDriver } from './generic';
import { copilotDriver } from './copilot';
import { cursorDriver } from './cursor';
import { opencodeDriver } from './opencode';
export const conformanceDrivers: Readonly<Record<string, FakeHarnessDriver>> = {
  claude: claudeDriver, codex: codexDriver, cursor: cursorDriver, opencode: opencodeDriver, generic: genericDriver, copilot: copilotDriver,
};
