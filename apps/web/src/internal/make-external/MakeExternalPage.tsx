import { useEffect, useMemo } from 'react';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import { createMakeExternalController, type MakeExternalControllerOptions } from './controller';
import { MakeExternalScreen } from './MakeExternalScreen';
import type { MakeExternalPort } from './port';

/** The Make-external route for one channel: owns the journey controller for as long as the page is shown. */
export function MakeExternalPage({ port, channelId, onBack, options }: {
  port: MakeExternalPort;
  channelId: string;
  onBack: () => void;
  options?: MakeExternalControllerOptions;
}) {
  const controller = useMemo(() => createMakeExternalController(port, channelId, options), [port, channelId, options]);
  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);
  return (
    <KhalaPageFrame model={{ title: 'Make external', description: 'Move this channel to a new hosted channel.', labelledBy: 'make-external-title' }}>
      <MakeExternalScreen controller={controller} onBack={onBack} />
    </KhalaPageFrame>
  );
}
