import type { FakeHarnessDriver } from '../driver';
import { claudeDriver } from './claude';
import { codexDriver } from './codex';
import { cursorDriver } from './cursor';
export const conformanceDrivers: Readonly<Record<string, FakeHarnessDriver>> = {
  claude: claudeDriver, codex: codexDriver, cursor: cursorDriver,
};
