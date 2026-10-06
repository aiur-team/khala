import type { FakeHarnessDriver } from '../driver';
import { claudeDriver } from './claude';
import { codexDriver } from './codex';
import { genericDriver } from './generic';
import { qwenDriver } from './qwen';
import { cursorDriver } from './cursor';
export const conformanceDrivers: Readonly<Record<string, FakeHarnessDriver>> = {
  claude: claudeDriver, codex: codexDriver, cursor: cursorDriver, generic: genericDriver, qwen: qwenDriver,
};
