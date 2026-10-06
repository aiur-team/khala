import type { FakeHarnessDriver } from '../driver';
import { museDriver } from './muse';
import { claudeDriver } from './claude';
import { codexDriver } from './codex';
import { genericDriver } from './generic';
import { cursorDriver } from './cursor';
export const conformanceDrivers: Readonly<Record<string, FakeHarnessDriver>> = {
  muse: museDriver, claude: claudeDriver, codex: codexDriver, cursor: cursorDriver, generic: genericDriver,
};
