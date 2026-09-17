import type { Api, LocationRenderFunction } from '@element-hq/element-web-module-api';
import { messages } from '../../fixtures/scenario';
// Only these host methods are synthetic. The ModuleLoader is the shipped package.
export function makeHarness() {
  const renderers = new Map<string, LocationRenderFunction>();
  const joins: unknown[] = [];
  const roomProps: unknown[] = [];
  const partial: Pick<Api, 'navigation' | 'builtins'> = {
    navigation: {
      registerLocationRenderer(path, renderer) { renderers.set(path, renderer); },
      openRoom(room, options) { joins.push({ room, options }); },
      async toMatrixToLink() { throw new Error('Not implemented by fixture'); },
    },
    builtins: {
      renderRoomView(_room, props) { roomProps.push(props); return <section className="panel" aria-label="Timeline"><h2>Launch notes · synthetic built-in substitute</h2>{messages.map(message => <article key={message.id}><strong>{message.author}</strong><p>{message.text}</p></article>)}</section>; },
      renderRoomAvatar() { return null; }, renderNotificationDecoration() { return null; },
    },
  };
  return { api: partial as Api, renderers, joins, roomProps };
}
