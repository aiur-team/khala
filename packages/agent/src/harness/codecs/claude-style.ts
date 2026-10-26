import { createClaudeStyleCodec } from '@khala/listener';
import { STOP_NUDGE, type DeliverCodec } from '../adapter';

export { createClaudeStyleCodec } from '@khala/listener';
export const claudeStyleCodec: DeliverCodec = createClaudeStyleCodec(STOP_NUDGE);

/** Claude shows a Stop block reason twice (as a user turn and as a system note). Stop additionalContext
 * arrives once and the turn continues, but that is verified only from this version (live, 2.1.307);
 * older or unknown versions keep the documented decision:block, which is always shown. A block reason is a
 * user turn, so it carries only STOP_NUDGE. */
export const claudeCodec: DeliverCodec = { ...claudeStyleCodec, stopContextFloor: '2.1.307' };
