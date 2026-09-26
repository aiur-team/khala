import type { BindingId, DeliveryLimits } from '@khala/contracts/delivery/index';
import type { RoomId } from '@khala/contracts/messaging/index';
import type { HumanRouteContext } from '../human/application';
import type { HumanCapability } from '../human/capabilities';
import { type BrowserReviewPort, createBrowserReviewPort, type ReviewControlClient } from './browser-port';

export type BrowserReviewDependencies = Readonly<{
  /** The protected human review transport; it attaches owner authority out of band. */
  client: ReviewControlClient;
  limits: DeliveryLimits;
  /** The signed-in human's own agent binding in a room, or null when they have none there. */
  bindingFor(context: HumanRouteContext, roomId: RoomId): BindingId | null;
  refreshMs?: number;
}>;

export type ReviewCapability = HumanCapability & Readonly<{
  /**
   * A review port scoped to the attached route. Null while unavailable, before
   * attachment, after the route ended, or when the human has no agent in the room.
   */
  portFor(context: HumanRouteContext, roomId: RoomId): BrowserReviewPort | null;
}>;

const UNAVAILABLE: ReviewCapability = Object.freeze({
  id: 'review' as const,
  state: 'unavailable' as const,
  attach: () => ({ dispose() {} }),
  portFor: () => null,
});

/**
 * Replaces the KHA-132 placeholder in place. Without the protected review
 * transport the slot stays `unavailable` and no substitute channel is opened.
 */
export function registerReview(dependencies?: BrowserReviewDependencies): ReviewCapability {
  if (!dependencies) return UNAVAILABLE;
  const attached = new Map<HumanRouteContext, Set<BrowserReviewPort>>();

  return Object.freeze({
    id: 'review' as const,
    state: 'ready' as const,

    attach(context: HumanRouteContext) {
      const ports = new Set<BrowserReviewPort>();
      attached.set(context, ports);
      return {
        dispose() {
          if (attached.get(context) !== ports) return;
          attached.delete(context);
          for (const port of ports) port.dispose();
          ports.clear();
        },
      };
    },

    portFor(context: HumanRouteContext, roomId: RoomId) {
      const ports = attached.get(context);
      if (!ports) return null;
      const bindingId = dependencies.bindingFor(context, roomId);
      if (bindingId === null) return null;
      const port = createBrowserReviewPort({
        client: dependencies.client,
        room: context.room,
        roomId,
        bindingId,
        viewerOwnerId: context.principal.ownerId,
        limits: dependencies.limits,
        ...(dependencies.refreshMs === undefined ? {} : { refreshMs: dependencies.refreshMs }),
      });
      ports.add(port);
      return port;
    },
  });
}
