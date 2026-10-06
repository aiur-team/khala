import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { ChannelNameDialog } from './ChannelNameDialog';

test('name collision is an inline region with a suggestion and dismissal', () => {
  const html = renderToStaticMarkup(<ChannelNameDialog prompt={{ participantId: 'alice2', kind: 'human', name: 'alice',
    held: 'alice', suggestion: 'alice2', reason: 'collision', taken: ['alice'] }} onSave={async () => ({ kind: 'ok' })} />);
  expect(html).toContain('role="region"');
  expect(html).toContain('value="alice2"');
  expect(html).toContain('Dismiss');
  expect(html).not.toContain('aria-modal');
  expect(html).not.toContain('autofocus');
});
