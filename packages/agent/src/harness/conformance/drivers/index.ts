import type { FakeHarnessDriver } from '../driver';
import { claudeDriver } from './claude';
import { codexDriver } from './codex';
import { genericDriver } from './generic';
import { cursorDriver } from './cursor';
import { geminiDriver } from './gemini';
export const conformanceDrivers: Readonly<Record<string, FakeHarnessDriver>> = {
  claude: claudeDriver, codex: codexDriver, cursor: cursorDriver, gemini: geminiDriver, generic: genericDriver,
};
