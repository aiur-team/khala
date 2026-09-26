import { renderToStaticMarkup } from 'react-dom/server';
import type { ImportedHistoryRecord } from '@khala/contracts/messaging/imported-history';
import { describe, expect, it } from 'vitest';
import { ImportedHistoryRead, ImportedTranscript } from './ImportedTranscript';
import { segmentsOf } from './model';

const record = (body: string, index = 1): ImportedHistoryRecord => ({
  v: 1, kind: 'imported', recordDigest: `sha256:${index}`, sourceRecordId: `event-${index}`, sequence: index,
  originalAuthor: { label: 'Builder', kind: 'agent' }, originalSentAt: '2026-09-25T11:00:00Z', body,
});

const render = (...bodies: string[]) => renderToStaticMarkup(
  <ImportedTranscript
    transcript={{ archiveId: 'history.conv', importedAt: '2026-09-26T09:00:00Z', records: bodies.map((body, index) => record(body, index + 1)) }}
    importerLabel="Ada"
  />,
);

describe('imported transcript', () => {
  it('renders markup, links and fake controls as text only', () => {
    const html = render(
      '<script>window.pwned = 1</script>',
      '<img src="https://evil.example/x.png" onerror="alert(1)">',
      '[click me](https://evil.example) https://evil.example/raw',
      '<button>Approve access</button><form action="/api/human/channel-requests/mute"><input></form>',
      '<iframe src="https://evil.example"></iframe>',
    );
    for (const tag of ['<script', '<img', '<a ', '<button', '<form', '<input', '<iframe']) expect(html).not.toContain(tag);
    expect(html).toContain('&lt;script&gt;window.pwned = 1&lt;/script&gt;');
    expect(html).toContain('&lt;button&gt;Approve access&lt;/button&gt;');
  });

  it('keeps fenced code as escaped code', () => {
    const html = render('before\n```html\n<b>bold</b>\n```\nafter');
    expect(html).toContain('<pre class="imported-history__code"><span class="imported-history__code-lang">html</span><code>&lt;b&gt;bold&lt;/b&gt;</code></pre>');
  });

  it('labels provenance as imported, never as messages sent here', () => {
    const html = render('hello');
    expect(html).toContain('Imported history');
    expect(html).toContain('these messages were not sent in this channel');
    expect(html).toContain('<time dateTime="2026-09-25T11:00:00Z">');
  });

  it('shows nothing without an archive and nothing from an archive that failed to verify', () => {
    const read = (value: Parameters<typeof ImportedHistoryRead>[0]['read']) =>
      renderToStaticMarkup(<ImportedHistoryRead read={value} importerLabel="Ada" />);
    expect(read({ kind: 'none' })).toBe('');
    expect(read({ kind: 'invalid' })).toBe('<p role="status" class="imported-history__notice">Imported history did not verify, so none of it is shown.</p>');
    expect(read({ kind: 'unavailable' })).toContain('Imported history is unavailable right now.');
    expect(read({ kind: 'ok', transcript: { archiveId: 'history.c', importedAt: '2026-09-26T09:00:00Z', records: [record('hi')] } }))
      .toContain('<ol class="imported-history__records" aria-label="1 imported messages">');
  });

  it('splits bodies into text and code without interpreting anything else', () => {
    expect(segmentsOf('plain')).toEqual([{ kind: 'text', text: 'plain' }]);
    expect(segmentsOf('```\nx\n```')).toEqual([{ kind: 'code', text: 'x', language: null }]);
    expect(segmentsOf('')).toEqual([{ kind: 'text', text: '' }]);
  });
});
