// An encrypted image inline in the thread, iOS Messages style: no bubble
// fill, rounded corners, aspect-preserving size. Tap opens it full screen,
// where the native long-press callout ("Save to Photos") is left on.
import { useEffect, useState, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ImageRef } from '@khala/contracts/m1/image';
import { saveImage } from './image-media';

const MAX_W = 240;
const MAX_H = 320;
const stop = (event: SyntheticEvent) => event.stopPropagation();

export function ChatImage({ image, load }: Readonly<{ image: ImageRef; load: (image: ImageRef) => Promise<Blob> }>) {
  const [state, setState] = useState<{ blob: Blob; url: string } | 'loading' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    setState('loading');
    load(image).then(blob => {
      if (!live) return;
      url = URL.createObjectURL(blob);
      setState({ blob, url });
    }, () => { if (live) setState('error'); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
    // Keyed on the URL: timeline snapshots rebuild content objects, and that must not reload the image.
  }, [image.url, load, attempt]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  const width = Math.round(Math.min(MAX_W, image.w, MAX_H * image.w / image.h));
  const style = { width, aspectRatio: `${image.w} / ${image.h}` };
  if (state === 'error') {
    return <button type="button" className="kh-img kh-img--error" style={style} onClick={() => setAttempt(n => n + 1)}>
      Image unavailable. Tap to retry.</button>;
  }
  if (state === 'loading') return <span className="kh-img kh-img--loading" style={style} role="img" aria-label={`Loading ${image.name}`} />;
  return <>
    <button type="button" className="kh-img" style={style} aria-label={`Open ${image.name}`} onClick={() => setOpen(true)}>
      <img src={state.url} alt={image.name} width={image.w} height={image.h} draggable={false} />
    </button>
    {/* Portalled out of the bubble so its no-callout style and press-and-hold menu never reach the viewer;
        React still bubbles portal events to the bubble, so they stop here. */}
    {open ? createPortal(<div className="kh-viewer" role="dialog" aria-modal="true" aria-label={image.name} onClick={() => setOpen(false)}
      onPointerDown={stop} onContextMenu={stop} onKeyDown={stop}>
      <img src={state.url} alt={image.name} onClick={event => event.stopPropagation()} />
      <div className="kh-viewer__bar" onClick={event => event.stopPropagation()}>
        <button type="button" className="kh-btn" onClick={() => saveImage(state.blob, image.name)}>Save Image</button>
        <button type="button" className="kh-btn" autoFocus onClick={() => setOpen(false)}>Close</button>
      </div>
    </div>, document.body) : null}
  </>;
}
