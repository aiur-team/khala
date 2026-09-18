import { it } from 'vitest';
import { LIVE_CASE_PREFIX } from '../../live';

// Named like a live case, but not declared through `describeLive` and proves nothing.
it(`${LIVE_CASE_PREFIX}totally real`, () => undefined);
