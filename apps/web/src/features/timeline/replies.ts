// iOS-style inline reply threads over Matrix rich replies (`m.in_reply_to`).
// A thread is a root message plus every loaded reply that chains back to it.

type Node = Readonly<{ id: string; parent?: string | undefined }>;

export type ReplyIndex = Readonly<{
  /** Direct replies per message. */
  counts: ReadonlyMap<string, number>;
  /** The loaded root of `id`'s chain, or `id` itself. */
  rootOf(id: string): string;
  /** The whole chain `id` belongs to, root first, in timeline order. */
  thread(id: string): readonly string[];
}>;

export function indexReplies(nodes: readonly Node[]): ReplyIndex {
  const parents = new Map<string, string>();
  const counts = new Map<string, number>();
  const loaded = new Set(nodes.map(node => node.id));
  for (const node of nodes) {
    if (node.parent === undefined) continue;
    parents.set(node.id, node.parent);
    if (loaded.has(node.parent)) counts.set(node.parent, (counts.get(node.parent) ?? 0) + 1);
  }
  const rootOf = (id: string) => {
    const seen = new Set<string>();
    let current = id;
    // Stops at an unloaded parent, and at a cycle a hostile sender could forge.
    while (!seen.has(current)) {
      seen.add(current);
      const parent = parents.get(current);
      if (parent === undefined || !loaded.has(parent)) break;
      current = parent;
    }
    return current;
  };
  return {
    counts,
    rootOf,
    thread: id => {
      const root = rootOf(id);
      return nodes.filter(node => node.id === root || rootOf(node.id) === root).map(node => node.id);
    },
  };
}

/** One line of a message for a quote: collapsed whitespace, cut at `max` characters. */
export function snippet(body: string, max = 80): string {
  const line = body.replace(/\s+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
