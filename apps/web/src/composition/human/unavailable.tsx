import { createRoot } from 'react-dom/client';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import type { HostedConfigKey } from './hosted-config';

const MODEL = {
  title: 'Khala is unavailable',
  description: 'This site is missing its server configuration, so channels cannot load here.',
  labelledBy: 'khala-unavailable-title',
};

/** The explicit screen a misconfigured deployment shows instead of a blank page. */
export function HostedUnavailableScreen({ missing }: Readonly<{ missing: readonly HostedConfigKey[] }>) {
  return (
    <KhalaPageFrame model={MODEL}>
      <p role="alert">Ask the operator of this site to set {missing.join(' and ')} to a valid HTTPS origin, then redeploy.</p>
    </KhalaPageFrame>
  );
}

export function mountHostedUnavailable(target: Element, missing: readonly HostedConfigKey[]): void {
  createRoot(target).render(<HostedUnavailableScreen missing={missing} />);
}
