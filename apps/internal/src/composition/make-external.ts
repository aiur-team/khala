import type {
  ConversionAccessPort, ConversionBindingPort, ConversionSessionPort, HostedChannelPort,
} from '@khala/contracts/messaging/externalization';
import type { ImportedHistoryLimits } from '@khala/contracts/messaging/imported-history';
import type { ImportedHistoryTransport } from '@khala/messaging/channels/history-import';
import type { HistoryDrainCeiling, HistoryExportLogEntry } from '../externalization/history-export';
import { type ConversionJournal, createConversionJournal } from '../externalization/journal';
import { type ConversionService, createConversionService } from '../externalization/service';
import type { HistoryTransferLedger } from '../externalization/transfer-ledger';
import type { InternalStoreHandle } from '../store/open';
import { type MakeExternalJourney, createMakeExternalJourney } from '../web/make-external/journey';
import type { HostedSignInPort } from '../web/make-external/ports';
import { createSourceWriteGate } from '../web/make-external/source-gate';
import { conversionTarget } from '../web/make-external/target';
import { createComposedHistoryExport } from './history-transfer';

// Composition root of the Make-external journey. The hosted ports act as the human
// who completed the journey's hosted sign-in. History transfer, when present, takes
// its destination from the conversion journal and its signed-in owner from that same
// sign-in, and writes through the external channel's encrypted imported-history
// transport; without it the journey offers start-fresh only.

export type MakeExternalHistoryDeps = Readonly<{
  transport: ImportedHistoryTransport;
  ledger: HistoryTransferLedger;
  limits: ImportedHistoryLimits;
  ceiling: HistoryDrainCeiling;
  now: () => number;
  log?: (entry: HistoryExportLogEntry) => void;
}>;

export type MakeExternalCompositionDeps = Readonly<{
  handle: InternalStoreHandle;
  hosted: HostedChannelPort;
  sessions: ConversionSessionPort;
  access: ConversionAccessPort;
  bindings: ConversionBindingPort;
  signIn: HostedSignInPort;
  destinationUrl: (destinationChannelId: string) => string | null;
  history?: MakeExternalHistoryDeps;
  /** Test seam passed to the conversion service; see `ConversionServiceDeps.beforeLink`. */
  beforeLink?: () => void | Promise<void>;
}>;

export type ComposedMakeExternal = Readonly<{
  journal: ConversionJournal;
  service: ConversionService;
  journey: MakeExternalJourney;
}>;

export function composeMakeExternal(deps: MakeExternalCompositionDeps): ComposedMakeExternal {
  const journal = createConversionJournal(deps.handle);
  let journey: MakeExternalJourney | null = null;
  const history = deps.history
    ? createComposedHistoryExport({
      source: deps.handle,
      journal,
      ledger: deps.history.ledger,
      transport: deps.history.transport,
      gate: createSourceWriteGate(deps.handle),
      session: () => journey?.signedIn() ?? null,
      target: conversionTarget(journal),
      limits: deps.history.limits,
      ceiling: deps.history.ceiling,
      now: deps.history.now,
      ...(deps.history.log ? { log: deps.history.log } : {}),
    })
    : undefined;
  const service = createConversionService({
    journal,
    hosted: deps.hosted,
    sessions: deps.sessions,
    access: deps.access,
    bindings: deps.bindings,
    ...(history ? { history } : {}),
    ...(deps.beforeLink ? { beforeLink: deps.beforeLink } : {}),
  });
  journey = createMakeExternalJourney({
    handle: deps.handle, journal, service, signIn: deps.signIn, destinationUrl: deps.destinationUrl,
  });
  return { journal, service, journey };
}
