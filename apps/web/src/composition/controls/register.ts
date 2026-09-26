import type { BindingId } from '@khala/contracts/delivery/index';
import type { RoomId } from '@khala/contracts/messaging/index';
import type { HumanRouteContext } from '../human/application';
import type { HumanCapability } from '../human/capabilities';
import { type BrowserAgentControlsPort, type ControlsClient, createBrowserAgentControlsPort } from './browser-port';

export type BrowserControlsDependencies = Readonly<{
  /** The protected human controls transport; it attaches owner authority out of band. */
  client: ControlsClient;
  /** The signed-in human's own agent binding in a room, or null when they have none there. */
  bindingFor(context: HumanRouteContext, roomId: RoomId): BindingId | null;
  refreshMs?: number;
}>;

export type ControlsCapability = HumanCapability & Readonly<{
  /**
   * A controls port scoped to the attached route. Null while unavailable, before
   * attachment, after the route ended, or when the human has no agent in the room.
   */
  portFor(context: HumanRouteContext, roomId: RoomId): BrowserAgentControlsPort | null;
}>;

const UNAVAILABLE: ControlsCapability = Object.freeze({
  id: 'controls' as const,
  state: 'unavailable' as const,
  attach: () => ({ dispose() {} }),
  portFor: () => null,
});

/**
 * Replaces the KHA-132 placeholder in place. Without the protected controls
 * transport the slot stays `unavailable` and no substitute channel is opened.
 */
export function registerControls(dependencies?: BrowserControlsDependencies): ControlsCapability {
  if (!dependencies) return UNAVAILABLE;
  // One port per room and binding for each attached route; route teardown disposes them,
  // so an account switch or pane change leaves no observer behind.
  const attached = new Map<HumanRouteContext, Map<string, BrowserAgentControlsPort>>();
  const disposeAll = (ports: Map<string, BrowserAgentControlsPort>) => {
    for (const port of ports.values()) port.dispose();
    ports.clear();
  };

  return Object.freeze({
    id: 'controls' as const,
    state: 'ready' as const,

    attach(context: HumanRouteContext) {
      const previous = attached.get(context);
      if (previous) disposeAll(previous);
      const ports = new Map<string, BrowserAgentControlsPort>();
      attached.set(context, ports);
      return {
        dispose() {
          if (attached.get(context) === ports) attached.delete(context);
          disposeAll(ports);
        },
      };
    },

    portFor(context: HumanRouteContext, roomId: RoomId) {
      const ports = attached.get(context);
      if (!ports) return null;
      const bindingId = dependencies.bindingFor(context, roomId);
      if (bindingId === null) return null;
      const key = JSON.stringify([roomId, bindingId]);
      const existing = ports.get(key);
      if (existing) return existing;
      const port = createBrowserAgentControlsPort({
        client: dependencies.client,
        bindingId,
        ...(dependencies.refreshMs === undefined ? {} : { refreshMs: dependencies.refreshMs }),
      });
      ports.set(key, port);
      return port;
    },
  });
}
