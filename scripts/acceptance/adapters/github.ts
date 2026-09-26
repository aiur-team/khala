// GitHub through the `gh` CLI, on the one acceptance repository only.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertCommand } from '../guard';
import { ACCEPTANCE_REPOSITORY, type GitHubPort, type IssueRecord } from '../types';

const run = promisify(execFile);

function onlyAcceptanceRepository(repository: string): void {
  if (repository !== ACCEPTANCE_REPOSITORY) throw new Error(`the live runner only touches ${ACCEPTANCE_REPOSITORY}`);
}

export function ghGitHub(khalaPackage: string): GitHubPort {
  async function gh(args: readonly string[]): Promise<string> {
    const argv = ['gh', ...args];
    assertCommand(argv, khalaPackage);
    const { stdout } = await run(argv[0]!, argv.slice(1), { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }

  function issue(repository: string, raw: string): IssueRecord {
    const value = JSON.parse(raw) as {
      number: number; title: string; body: string | null; state: string; created_at: string; labels: { name: string }[];
    };
    return {
      number: value.number, repository, title: value.title, body: value.body ?? '', labels: value.labels.map(label => label.name),
      state: value.state === 'closed' ? 'closed' : 'open', createdAt: value.created_at,
    };
  }

  return {
    async preflight(repository, labels) {
      onlyAcceptanceRepository(repository);
      const permissions = JSON.parse(await gh(['api', `repos/${repository}`, '--jq', '.permissions'])) as { push?: boolean; triage?: boolean };
      if (!permissions.push && !permissions.triage) throw new Error(`the credential cannot write issues in ${repository}`);
      for (const label of labels) await gh(['api', `repos/${repository}/labels/${encodeURIComponent(label)}`, '--jq', '.name']);
    },
    async createIssue(input) {
      onlyAcceptanceRepository(input.repository);
      const args = ['api', '--method', 'POST', `repos/${input.repository}/issues`, '-f', `title=${input.title}`, '-f', `body=${input.body}`];
      for (const label of input.labels) args.push('-f', `labels[]=${label}`);
      return issue(input.repository, await gh(args));
    },
    async getIssue(repository, number) {
      onlyAcceptanceRepository(repository);
      return issue(repository, await gh(['api', `repos/${repository}/issues/${number}`]));
    },
    async closeIssue(repository, number, comment) {
      onlyAcceptanceRepository(repository);
      await gh(['api', '--method', 'POST', `repos/${repository}/issues/${number}/comments`, '-f', `body=${comment}`]);
      await gh(['api', '--method', 'PATCH', `repos/${repository}/issues/${number}`, '-f', 'state=closed', '-f', 'state_reason=completed']);
    },
    async linkedPullRequests(repository, number) {
      onlyAcceptanceRepository(repository);
      const raw = await gh([
        'api', `repos/${repository}/issues/${number}/timeline?per_page=100`,
        '--jq', '[.[] | select(.event == "cross-referenced" or .event == "connected") | .source.issue | select(.pull_request != null) | .number]',
      ]);
      return JSON.parse(raw || '[]') as number[];
    },
  };
}
