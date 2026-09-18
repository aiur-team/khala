import type { KhalaPageFrameProps } from './types';

export function KhalaPageFrame({ model, banner, children }: KhalaPageFrameProps) {
  return (
    <section className="khala-page-frame" aria-labelledby={model.labelledBy}>
      <header className="khala-page-frame__header">
        <h1 id={model.labelledBy}>{model.title}</h1>
        {model.description ? <p className="khala-page-frame__description">{model.description}</p> : null}
      </header>
      {banner ? (
        <div className="khala-page-frame__banner" role="status">
          {banner}
        </div>
      ) : null}
      <div className="khala-page-frame__body">{children}</div>
    </section>
  );
}
