import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChannelRequestsInbox } from '../ChannelRequestsInbox';
import { ChannelRequestsNavEntry } from '../ChannelRequestsNavEntry';
import { createChannelAccessInboxController } from '../controller';
import { createFakeJournal, type FakeCaller, type FakeRequestInput } from '../fakes';

/**
 * Synthetic ports for the browser harness only: an in-memory journal with no
 * network calls or credentials. `window.__channelAccessHarness` lets the spec
 * play the agent side, another window, and the connector.
 */
const journal = createFakeJournal({ delayMs: 120 });
const decideOperations: string[] = [];
const decide = journal.port.decide.bind(journal.port);
journal.port.decide = async (input, options) => {
  decideOperations.push(input.operationId);
  return decide(input, options);
};

declare global {
  interface Window {
    __channelAccessHarness: {
      submit(input: FakeRequestInput): string | null;
      advance(handle: string, outcome: 'connecting' | 'connected' | 'repair_required' | 'revoked'): void;
      failNextDecide(kind: 'unavailable'): void;
      setCaller(caller: FakeCaller): void;
      decideOperations(): readonly string[];
      refresh(): void;
    };
  }
}

const HANDLE_ROUTE = /^#\/channel-requests\/(careq_[A-Za-z0-9_-]{43})$/;
const handleFromHash = (): string | null | undefined => {
  const match = HANDLE_ROUTE.exec(window.location.hash);
  return match ? match[1]! : undefined;
};

function Harness() {
  const controller = useMemo(() => createChannelAccessInboxController({ requests: journal.port }), []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selected, setSelected] = useState<string | null | undefined>(handleFromHash);

  useEffect(() => {
    controller.start();
    window.__channelAccessHarness = {
      submit: input => journal.submit(input),
      advance: (handle, outcome) => journal.advance(handle, outcome),
      failNextDecide: kind => {
        journal.failNext.decide.push(kind);
      },
      setCaller: caller => journal.setCaller(caller),
      decideOperations: () => decideOperations,
      refresh: () => controller.refresh(),
    };
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    const onHash = () => {
      const handle = handleFromHash();
      // Revisiting the same link still lands on the row.
      if (handle !== undefined) {
        setSelected(undefined);
        queueMicrotask(() => setSelected(handle));
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="harness">
      <nav className="harness__nav" aria-label="Main navigation" data-open={String(menuOpen)}>
        <button type="button" className="harness__toggle" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          Menu
        </button>
        <ul className="harness__menu">
          <li>
            <ChannelRequestsNavEntry controller={controller} href="#/channel-requests" current />
          </li>
        </ul>
      </nav>
      <main>
        <ChannelRequestsInbox controller={controller} selectedHandle={selected} />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
