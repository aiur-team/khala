import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiurShell } from '../AiurShell';
import { KhalaPageFrame } from '../KhalaPageFrame';
import { Panel } from '../Panel';
import { StatusBadge } from '../StatusBadge';
import type { NavigationItem, ThemeChoice } from '../types';

const navigation: NavigationItem[] = [
  { id: 'conversations', label: 'Conversations', href: '#conversations', current: true, count: 2 },
  { id: 'long', label: 'A rather long navigation destination name that could wrap', href: '#long', current: false },
];

const hostedMode = new URLSearchParams(window.location.search).get('mode') === 'hosted';

function Harness() {
  const [theme, setTheme] = useState<ThemeChoice>('dark');
  const [collapsed, setCollapsed] = useState(false);
  return (
    <AiurShell
      mode={hostedMode ? 'hosted-content' : 'standalone'}
      navigation={navigation}
      theme={{ theme, onThemeChange: setTheme }}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
    >
      <KhalaPageFrame model={{ title: 'Khala', description: 'One shared plan.', labelledBy: 'khala-heading' }}>
        <Panel heading="Launch notes">
          <p>{'A long wrapping synthetic message with no attachments and no real credentials. '.repeat(6)}</p>
        </Panel>
        <Panel
          heading="Human review"
          footer={
            <button type="button" aria-describedby="review-hint">
              Review selected batch
            </button>
          }
        >
          <p id="review-hint">Synthetic harness control; not a real approval surface.</p>
          <StatusBadge tone="caution" label="Delivery unknown" />
        </Panel>
      </KhalaPageFrame>
    </AiurShell>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
