// A stand-in hook or slash-command process: the registered `khala claude` command
// with a descriptor-backed client. It receives only the descriptor path.
import { runCli } from '../cli/app.js';
import { createUnavailableClient } from '../composition/unavailable.js';
import { createClaudeSessionClient } from '../composition/claude-session-http.js';

const [descriptorPath, ...argv] = process.argv.slice(2);
process.exitCode = await runCli(['claude', ...argv], {
  client: createUnavailableClient(),
  inbox: async () => { throw new Error('a Claude process never opens inbox storage'); },
  claude: createClaudeSessionClient({ descriptorPath: descriptorPath! }),
  stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
});
