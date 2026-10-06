import type { FakeHarnessDriver } from '../driver';
import { museDriver } from './muse';
import { claudeDriver } from './claude';
import { codexDriver } from './codex';
import { genericDriver } from './generic';
import { copilotDriver } from './copilot';
import { cursorDriver } from './cursor';
import { geminiDriver } from './gemini';
import { opencodeDriver } from './opencode';
export const conformanceDrivers: Readonly<Record<string, FakeHarnessDriver>> = {
  muse: museDriver, claude: claudeDriver, codex: codexDriver, cursor: cursorDriver, gemini: geminiDriver, opencode: opencodeDriver, generic: genericDriver, copilot: copilotDriver,
};
