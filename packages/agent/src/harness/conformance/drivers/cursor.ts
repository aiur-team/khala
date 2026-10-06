import { cursorSessionId } from '../../../cursor';
import type { FakeHarnessDriver } from '../driver';
const workspace = '/conformance/workspace';
export const cursorDriver: FakeHarnessDriver = {
  newSession: () => ({ id: cursorSessionId(workspace), workspace,
    mcpEnv: { KHALA_CURSOR_WORKSPACE: workspace } }),
  hookStdin: (event, session) => JSON.stringify({
    hook_event_name: { prompt: 'beforeSubmitPrompt', tool: 'postToolUse', stop: 'stop' }[event],
    workspace_roots: [session.workspace], loop_count: session.continuation ? 1 : 0,
    ...(session.promptText !== undefined ? { prompt: session.promptText } : {}),
  }),
  readHookStdout(stdout) {
    const output = JSON.parse(stdout);
    if (output.followup_message) return { kind: 'continue', frame: output.followup_message };
    if (output.additional_context) return { kind: 'context', frame: output.additional_context };
    return { kind: 'none' };
  },
};
