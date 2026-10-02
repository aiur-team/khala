// Message runs (RECREATION-SPEC §7.1, `khRender` source:4283-4294): consecutive
// messages from one participant share a run. Any other row — a day separator,
// an event or an unavailable message — breaks it.

export type RunInput = Readonly<{ kind: 'message'; participantId: string; isViewer: boolean }> | Readonly<{ kind: 'break' }>;

export type RunPosition = Readonly<{
  first: boolean;
  mid: boolean;
  lastOf: boolean;
  /** The name line: first row of a run, never the viewer's. */
  showName: boolean;
  /** Viewer rows have no avatar element at all. */
  showAvatar: boolean;
  /** The avatar keeps its slot but is hidden on every row except the last of its run. */
  ghost: boolean;
}>;

const sameSender = (item: RunInput | undefined, participantId: string) =>
  item?.kind === 'message' && item.participantId === participantId;

/** One position per input; `null` for every break. */
export function computeRuns(items: readonly RunInput[]): readonly (RunPosition | null)[] {
  return items.map((item, index) => {
    if (item.kind !== 'message') return null;
    const first = !sameSender(items[index - 1], item.participantId);
    const last = !sameSender(items[index + 1], item.participantId);
    return {
      first,
      mid: !first && !last,
      lastOf: last && !first,
      showName: first && !item.isViewer,
      showAvatar: !item.isViewer,
      ghost: !item.isViewer && !last,
    };
  });
}

/** `first`, `mid` or `last-of`: a single message is `first` only. */
export function runClass(position: RunPosition): string {
  if (position.first) return 'first';
  return position.mid ? 'mid' : 'last-of';
}
