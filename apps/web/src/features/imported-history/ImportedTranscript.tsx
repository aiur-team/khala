import { useEffect, useState } from 'react';
import type { ImportedHistoryRecord } from '@khala/contracts/messaging/imported-history';
import { type ImportedHistoryRead, type ImportedTranscript as Transcript, formatImportedTime, segmentsOf } from './model';
import type { ImportedHistoryPort } from './ports';

// Imported bodies are inert. They render only as React text inside <p> and <pre><code>:
// no HTML is parsed, no element is derived from a body (no link, image, frame, form or
// control), nothing loads from the network, and nothing here can reach an agent.

function Body({ body }: { body: string }) {
  return (
    <div className="imported-history__body">
      {segmentsOf(body).map((segment, index) => segment.kind === 'code'
        ? (
          <pre key={index} className="imported-history__code">
            {segment.language ? <span className="imported-history__code-lang">{segment.language}</span> : null}
            <code>{segment.text}</code>
          </pre>
        )
        : <p key={index} className="imported-history__text">{segment.text}</p>)}
    </div>
  );
}

function Record({ record }: { record: ImportedHistoryRecord }) {
  return (
    <li className="imported-history__record">
      <div className="imported-history__meta">
        <span className="imported-history__author">{record.originalAuthor.label}</span>
        {record.originalAuthor.kind === 'agent' ? <span className="imported-history__kind">agent</span> : null}
        <time dateTime={record.originalSentAt}>{formatImportedTime(record.originalSentAt)}</time>
      </div>
      <Body body={record.body} />
    </li>
  );
}

export function ImportedTranscript({ transcript, importerLabel }: { transcript: Transcript; importerLabel: string }) {
  return (
    <section className="imported-history" aria-labelledby={`imported-${transcript.archiveId}`}>
      <h2 id={`imported-${transcript.archiveId}`} className="imported-history__heading">Imported history</h2>
      <p className="imported-history__provenance">
        A read-only transcript {importerLabel} imported on {formatImportedTime(transcript.importedAt)}. Authors and times are as the
        internal channel recorded them; these messages were not sent in this channel and no agent receives them.
      </p>
      <ol className="imported-history__records" aria-label={`${transcript.records.length} imported messages`}>
        {transcript.records.map(record => <Record key={record.sourceRecordId} record={record} />)}
      </ol>
    </section>
  );
}

/** Loads a channel's imported archive once and shows it above the live timeline, or nothing. */
export function ImportedHistorySection({ port, channelId, importerLabel }: {
  port: ImportedHistoryPort;
  channelId: string;
  importerLabel: string;
}) {
  const [read, setRead] = useState<ImportedHistoryRead | null>(null);
  useEffect(() => {
    let live = true;
    setRead(null);
    void port.open(channelId).then(result => {
      if (live) setRead(result);
    }, () => {
      if (live) setRead({ kind: 'unavailable' });
    });
    return () => {
      live = false;
    };
  }, [port, channelId]);
  if (read === null || read.kind === 'none') return null;
  if (read.kind === 'invalid') {
    return <p role="status" className="imported-history__notice">Imported history did not verify, so none of it is shown.</p>;
  }
  if (read.kind === 'unavailable') return <p role="status" className="imported-history__notice">Imported history is unavailable right now.</p>;
  return <ImportedTranscript transcript={read.transcript} importerLabel={importerLabel} />;
}
