import type { FakeHarnessDriver } from '../driver';
import { claudeDriver } from './claude';
import { codexDriver } from './codex';
import { genericDriver } from './generic';
import { cursorDriver } from './cursor';
import { antigravityDriver } from './antigravity';
import { geminiDriver } from './gemini';
import { opencodeDriver } from './opencode';
export const conformanceDrivers: Readonly<Record<string, FakeHarnessDriver>> = {
  claude: claudeDriver, codex: codexDriver, cursor: cursorDriver, gemini: geminiDriver, antigravity: antigravityDriver, opencode: opencodeDriver, generic: genericDriver,
};
