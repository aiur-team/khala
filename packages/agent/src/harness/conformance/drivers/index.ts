import type { FakeHarnessDriver } from '../driver';
import { museDriver } from './muse';
import { claudeDriver } from './claude';
import { codexDriver } from './codex';
import { genericDriver } from './generic';
import { cursorDriver } from './cursor';
import { opencodeDriver } from './opencode';
export const conformanceDrivers: Readonly<Record<string, FakeHarnessDriver>> = {
  muse: museDriver, claude: claudeDriver, codex: codexDriver, cursor: cursorDriver, opencode: opencodeDriver, generic: genericDriver,
};
