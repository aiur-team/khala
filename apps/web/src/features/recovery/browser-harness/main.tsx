import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { AiurShell } from '../../../shell/AiurShell';
import { KhalaPageFrame } from '../../../shell/KhalaPageFrame';
import type { NavigationItem } from '../../../shell/types';
import { RecoveryPanel } from '../RecoveryPanel';
import type { RecoveryController } from '../controller';
import { projectRecoveryView } from '../model';
import {
  createFakeRecoveryPorts,
  roomId,
  type SyntheticClosureOutcome,
  type SyntheticRevocationOutcome,
} from './fake-recovery-port';

const navigation: NavigationItem[] = [{ id: 'recovery', label: 'Recovery', href: '#recovery', current: true }];
const fake = createFakeRecoveryPorts();
let setPanelMounted: ((mounted: boolean) => void) | null = null;
let setProbeController: ((controller: RecoveryController) => void) | null = null;
let closureCompleteCount = 0;

type LifecycleProbeController = RecoveryController & {
  completeClosure(): void;
};

function createLifecycleProbeController(): LifecycleProbeController {
  const listeners = new Set<() => void>();
  let view = projectRecoveryView(fake.ports.ui.snapshot());
  return {
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    beginRecovery: async () => null,
    beginRevocation: async () => null,
    beginClosure: async () => null,
    inspect: async () => null,
    cancel() {},
    dispose() {},
    completeClosure() {
      view = projectRecoveryView(fake.ports.ui.snapshot(), {
        kind: 'closure',
        operationId: 'stale-controller-closure',
        state: 'complete',
        reason: null,
      });
      listeners.forEach(listener => listener());
    },
  };
}

const oldProbeController = createLifecycleProbeController();
const currentProbeController = createLifecycleProbeController();

declare global {
  interface Window {
    __recoveryHarness: {
      setRevocationOutcome: (outcome: SyntheticRevocationOutcome) => void;
      setClosureOutcome: (outcome: SyntheticClosureOutcome) => void;
      emitUnchanged: () => void;
      setMounted: (mounted: boolean) => void;
      activateControllerReplacementProbe: () => void;
      replaceControllerAsOldClosureCompletes: () => void;
      getAudit: () => ReturnType<typeof fake.getAudit>;
      getClosureCompleteCount: () => number;
    };
  }
}

window.__recoveryHarness = {
  setRevocationOutcome: fake.setRevocationOutcome,
  setClosureOutcome: fake.setClosureOutcome,
  emitUnchanged: fake.emitUnchanged,
  setMounted: mounted => setPanelMounted?.(mounted),
  activateControllerReplacementProbe: () => setProbeController?.(oldProbeController),
  replaceControllerAsOldClosureCompletes: () => {
    setProbeController?.(currentProbeController);
    oldProbeController.completeClosure();
  },
  getAudit: fake.getAudit,
  getClosureCompleteCount: () => closureCompleteCount,
};

function Harness() {
  const [mounted, setMounted] = useState(true);
  const [probeController, updateProbeController] = useState<RecoveryController | null>(null);
  setPanelMounted = setMounted;
  setProbeController = updateProbeController;

  return (
    <AiurShell mode="hosted-content" navigation={navigation} theme={{ theme: 'dark', onThemeChange: () => {} }} collapsed={false} onCollapsedChange={() => {}}>
      <KhalaPageFrame model={{ title: 'Keys', labelledBy: 'recovery-heading' }}>
        <button type="button" onClick={() => setMounted(value => !value)}>
          {mounted ? 'Hide recovery controls' : 'Show recovery controls'}
        </button>
        <div data-probe-controller={probeController === oldProbeController ? 'old' : probeController === currentProbeController ? 'current' : 'owned'}>
          {mounted ? (
            <RecoveryPanel
              ports={fake.ports}
              config={{ roomId, roomRevision: 7, createOperationId: () => `synthetic-${Date.now()}` }}
              onClosureComplete={() => { closureCompleteCount += 1; }}
              {...(probeController === null ? {} : { controller: probeController })}
            />
          ) : null}
        </div>
      </KhalaPageFrame>
    </AiurShell>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
