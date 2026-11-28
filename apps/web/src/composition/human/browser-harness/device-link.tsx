import { createRoot } from 'react-dom/client';
import { DeviceLinkPrompt, type DeviceLink } from '../device-link';

const lockedState = { kind: 'locked' } as const;
const link: DeviceLink = {
  state: () => lockedState,
  subscribe: () => () => undefined,
  unlock: () => undefined,
  approve: () => undefined,
  dismiss: () => undefined,
  dispose: () => undefined,
};

createRoot(document.querySelector('#device-prompt')!).render(<DeviceLinkPrompt link={link} />);
