import { useRef, useState } from 'react';
import type { Api, Module, ModuleFactory } from '@element-hq/element-web-module-api';
import { batch, deliveryLabel, fixtureReviewPort } from '../../fixtures/scenario';

export function ModulePage({ api }: { api: Pick<Api, 'navigation' | 'builtins'> }) {
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState<'pending' | 'unknown' | 'acknowledged'>('pending');
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  return <section className="conversation"><p className="eyebrow">ELEMENT MODULE API HARNESS — SYNTHETIC HOST</p><h1>Khala</h1>
    {!joined ? <section className="panel"><h2>Invitation from Alex</h2><p>Account authentication is not exercised in this module harness.</p><button onClick={() => { api.navigation.openRoom('!fixture:example.invalid', { autoJoin: true }); setJoined(true); }}>Continue with account (fixture)</button></section> : <>
      {api.builtins.renderRoomView('!fixture:example.invalid', { hideHeader: true, hideRightPanel: true, hideWidgets: true })}
      <section className="panel"><h2>Human review</h2><p role="status">{deliveryLabel(status)}</p><button ref={opener} disabled={status !== 'pending'} onClick={() => dialog.current?.showModal()}>Review selected batch</button></section>
      <dialog ref={dialog} aria-labelledby="review-heading" onClose={() => opener.current?.focus()}><h2 id="review-heading">Review selected batch</h2><p>1 human event selected. Fixture approval only.</p><button autoFocus onClick={() => dialog.current?.close()}>Close review</button> <button onClick={async () => { try { setStatus(await fixtureReviewPort().approve(batch)); dialog.current?.close(); } catch { setError('Review failed. No confirmed delivery.'); } }}>Approve fixture batch</button>{error && <p role="alert">{error}</p>}</dialog>
    </>}
  </section>;
}
class KhalaFixtureModule implements Module {
  static readonly moduleApiVersion: string = '^2.0.0';
  constructor(private api: Api) {}
  async load() { this.api.navigation.registerLocationRenderer('khala-fixture', () => <ModulePage api={this.api} />); }
}
export default KhalaFixtureModule satisfies ModuleFactory;
