// Minimal `text/event-stream` reader over a fetch body. Native `EventSource`
// cannot send the request-secret header, so the hint stream is read by hand.
// Only event names matter: hint frames carry no content by design.

const MAX_FRAME_BYTES = 4096;

export type HintFrame = 'ready' | 'hint';

/**
 * Calls `onFrame` for each complete `ready` or `hint` event and `onActivity`
 * for every chunk, including keepalive comments. Resolves when the body ends;
 * rejects on a read error or an oversized frame.
 */
export async function readHintStream(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: HintFrame) => void,
  onActivity: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onActivity();
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
        if (event === 'ready' || event === 'hint') onFrame(event);
        boundary = buffer.indexOf('\n\n');
      }
      if (buffer.length > MAX_FRAME_BYTES) throw new Error('hint stream frame too large');
    }
  } finally {
    reader.releaseLock();
  }
}
