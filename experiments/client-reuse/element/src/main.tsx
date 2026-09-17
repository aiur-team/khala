import { createRoot } from 'react-dom/client';
import { ModuleLoader } from '@element-hq/element-web-module-api';
import FixtureModule from './module';
import { makeHarness } from './harness';
import '../../sdk/src/style.css';
const root = createRoot(document.getElementById('root')!);
const harness = makeHarness();
try {
  const loader = new ModuleLoader(harness.api);
  class Incompatible extends FixtureModule { static readonly moduleApiVersion = '^999.0.0'; }
  await loader.load({ default: new URLSearchParams(location.search).has('failure') ? Incompatible : FixtureModule });
  await loader.start();
  const page = harness.renderers.get('khala-fixture');
  if (!page) throw new Error('Review route missing');
  root.render(<div className="dashboard"><header className="topbar"><strong>Element host chrome (simulated)</strong></header><nav aria-label="Element navigation">Space panel retained</nav><main>{page()}</main></div>);
} catch { root.render(<main><h1>Module unavailable</h1><p role="alert">Review controls unavailable: module failed to load.</p></main>); }
