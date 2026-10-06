// Spawned hosted-boundary fixture: real CLI, MCP and client; the same fake
// join/Matrix transport as Tier A. No production test switch or network egress.
import { register } from 'tsx/esm/api';
register();
const { runCli } = await import('../../cli.ts');
const { runMcpCommand } = await import('../../mcp/main.ts');
const { createKhalaAgentClient } = await import('../../client-impl.ts');
const { adapterFor } = await import('../index.ts');
const { transportFixture } = await import('./run.ts');
process.exitCode = await runCli(process.argv.slice(2), {
  mcp: () => async () => ({ default: argv => runMcpCommand(argv, {
    createClient: input => {
      const fixture = transportFixture(adapterFor(input.harness), 'matrix');
      return createKhalaAgentClient({ ...input, env: process.env,
        joinApi: fixture.joinApi, startSession: fixture.startSession });
    },
  }) }),
  local: () => undefined, watch: () => undefined, install: () => undefined, hook: () => undefined,
});
