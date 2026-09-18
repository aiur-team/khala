import type { ReactNode } from 'react';

export type PanelStatus = 'idle' | 'busy' | 'empty' | 'error';

export interface PanelProps {
  heading: string;
  status?: PanelStatus;
  statusMessage?: string;
  footer?: ReactNode;
  children: ReactNode;
}

const DEFAULT_STATUS_MESSAGE: Record<Exclude<PanelStatus, 'idle'>, string> = {
  busy: 'Loading…',
  empty: 'Nothing here yet.',
  error: 'Something went wrong.',
};

export function Panel({ heading, status = 'idle', statusMessage, footer, children }: PanelProps) {
  return (
    <section className="panel" aria-busy={status === 'busy'}>
      <header className="panel__header">
        <h2>{heading}</h2>
      </header>
      <div className="panel__body">
        {status === 'idle' ? (
          children
        ) : (
          <p className="panel__status" role={status === 'error' ? 'alert' : 'status'}>
            {statusMessage ?? DEFAULT_STATUS_MESSAGE[status]}
          </p>
        )}
      </div>
      {footer ? <footer className="panel__footer">{footer}</footer> : null}
    </section>
  );
}
