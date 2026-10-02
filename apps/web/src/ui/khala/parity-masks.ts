// Screen-comparison masks for the design-parity audit (KM-186,
// RECREATION-SPEC §25.4): one entry per §22 "Omit" element that the design
// reference shows. The parity spec resolves each selector in the real design
// page (the same page `reference/capture.mjs` captured), then paints every
// resulting box on both the reference and the fixture screenshot before
// diffing. A mask never covers a region M1 renders.

export type ParityMask = Readonly<{
  id: string;
  /** Selectors in the design DOM (`source/Aiur Dashboard.html`), joined into one query. */
  selectors: readonly string[];
  reason: string;
  /** The RECREATION-SPEC §22 row that omits the element in M1. */
  row: string;
  /**
   * The element sits in flow at the start of a scroll container, so omitting it
   * moves everything after it. While the design container is scrolled to the
   * top, the fixture reserves the element's outer height at the start of
   * `fixture` (the product's container) and the mask covers both.
   */
  reserve?: Readonly<{ design: string; fixture: string }>;
}>;

export const PARITY_MASKS: readonly ParityMask[] = [
  {
    id: 'kh-ask', selectors: ['.kh-ask'],
    reason: 'The "Your agent?" adoption chip; M1 confirms agents on the confirm page (KM-134).',
    row: '`.kh-ask` "Your agent?" adoption — Omit',
    reserve: { design: '#kh-thread', fixture: '.kh-thread' },
  },
  {
    id: 'kh-badge', selectors: ['.kh-head .kh-badge'],
    reason: 'The header request badge counts approval requests, which are M2.',
    row: 'Header request badge, roster Requests group, approve/decline — Omit',
  },
  {
    id: 'roster-requests', selectors: ['.kh-roster-in > .kh-rg:has(.kh-req)'],
    reason: 'The roster Requests group with approve/decline.',
    row: 'Header request badge, roster Requests group, approve/decline — Omit',
    reserve: { design: '.kh-roster-in', fixture: '.kh-roster-in' },
  },
  {
    id: 'kh-crw', selectors: ['.kh-crw'],
    reason: 'The admin crown; the fixture has no known channel creator.',
    row: 'Admin crown — Live if the channel creator is known, else omit',
  },
  {
    id: 'kh-rai-p', selectors: ['.kh-rai-p'],
    reason: 'Roster progress bar and percentage from Aiur fleet data.',
    row: 'Progress bar and % (`.kh-rai-p`, `.kh-d-agent > i`, Working on) — Omit',
  },
  {
    id: 'kh-st', selectors: ['.kh-st'],
    reason: 'Agent status dots; the fixture presence has no known connection state.',
    row: 'Agent status dot `.kh-st` — omit when `unknown`',
  },
  {
    id: 'kebab', selectors: ['.kh-keb'],
    reason: 'Remove human/agent kebab menus.',
    row: 'Remove human/agent kebabs, `.kh-confirm` — Omit',
  },
  {
    id: 'gear', selectors: ['.kh-hacts [data-kh-act="settings"]'],
    reason: 'The header settings gear (Delete channel, Leave).',
    row: 'Settings (gear) popover, Delete channel, Leave menu — Omit',
  },
  {
    id: 'state-channels', selectors: ['[data-kh-convo="infra"]', '[data-kh-convo="old-launch"]', '[data-kh-convo="design-crit"]'],
    // khala-terminology-allow: quotes the design dataset's channel title, never rendered.
    reason: 'The pending, deleted and removed state channels (Infra on-call, 0.8 launch room, Design crit).',
    row: '`.dead` rows, state cards pending/deleted/removed/used — Omit',
  },
  {
    id: 'kh-react', selectors: ['.kh-react'],
    reason: 'Message reactions.',
    row: '`.kh-react` — Omit',
  },
  {
    id: 'detail-aiur', selectors: ['.kh-d-sec:has(> .kh-d-bar)', '.kh-d-sec:has(> .kh-d-kv)', '#kh-d-open'],
    reason: 'The agent detail Working on card, the Epic/Phase/Status/Runtime/Progress table and Open ticket, all Aiur data.',
    row: 'Detail: Working on, Epic/Phase/Status/Runtime/Progress kv, Open ticket — Omit',
  },
  {
    id: 'kh-d-agent-pct', selectors: ['.kh-d-agent > i'],
    reason: 'The per-agent percentage in a human\'s detail.',
    row: 'Progress bar and % (`.kh-rai-p`, `.kh-d-agent > i`, Working on) — Omit',
  },
  {
    // Operator request 2026-10-02: no machine tag; agent bubbles tinted by owner. The product deliberately
    // differs from the design here (not an M1 omission), so these regions are masked rather than re-captured.
    id: 'agent-row-owner-tint', selectors: ['#kh-thread .kh-row:not(.human):not(.me) .kh-name', '#kh-thread .kh-row:not(.human):not(.me) .kh-b'],
    reason: 'Agent rows drop the "<owner>’s machine" tag and tint the bubble with the owner\'s bubble colour.',
    row: 'operator request 2026-10-02: no machine tag; agent bubbles tinted by owner',
  },
  {
    // Operator request (#954): the brand row drops the Live badge; the product deliberately differs from the design.
    id: 'brand-live', selectors: ['.kh-brand .brand-live'],
    reason: 'The brand row\'s Live badge, removed from the signed-in app.',
    row: 'operator request #954: no Live badge in the brand row',
  },
];
