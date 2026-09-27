import { useEffect, useState } from 'react';
import type { MakeExternalJourneyView } from '@khala/contracts/messaging/make-external';
import { isEnded } from './model';
import type { MakeExternalPort } from './port';

// The internal channel page's view of Make external: the action that opens the
// journey, a way back into a journey under way, and, once the channel is linked, the
// notice that it is read-only and where its conversation continues.

export type JourneySummary =
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'known'; view: MakeExternalJourneyView }>;

export function useJourneySummary(port: MakeExternalPort | null, channelId: string): JourneySummary {
  const [summary, setSummary] = useState<JourneySummary>({ kind: port ? 'unknown' : 'absent' });
  useEffect(() => {
    if (!port) return;
    let live = true;
    void port.view(channelId).then(read => {
      if (!live) return;
      if (read.kind === 'ok') setSummary({ kind: 'known', view: read.view });
      else if (read.kind !== 'unavailable') setSummary({ kind: 'absent' });
    });
    return () => {
      live = false;
    };
  }, [port, channelId]);
  return summary;
}

/** Why the composer is closed for a linked channel, or null. */
export function linkedSendReason(summary: JourneySummary): string | null {
  if (summary.kind !== 'known') return null;
  if (summary.view.sourceWrite === 'linked') return 'This channel is read-only. Its conversation continues in the external channel.';
  if (summary.view.sourceWrite === 'paused') return 'Sending is paused while this channel moves to an external channel.';
  return null;
}

export function MakeExternalEntry({ summary, onOpen }: { summary: JourneySummary; onOpen: () => void }) {
  if (summary.kind !== 'known') return null;
  const { view } = summary;
  const url = view.conversion?.destinationUrl ?? null;
  if (view.sourceWrite === 'linked') {
    return (
      <div className="make-external__moved" role="note">
        <p>This channel moved to an external channel and is read-only.</p>
        {url ? <a href={url} rel="noopener noreferrer" target="_blank">Open the external channel</a> : null}{' '}
        {view.conversion?.state === 'activating'
          ? <button type="button" onClick={onOpen}>Finish activation</button>
          : null}
      </div>
    );
  }
  const underway = view.conversion !== null && !isEnded(view);
  return (
    <button type="button" onClick={onOpen}>{underway ? 'Continue making this channel external' : 'Make external'}</button>
  );
}
