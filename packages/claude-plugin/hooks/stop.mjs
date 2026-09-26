// Khala hook entry point: the runtime in lib/runtime.mjs does the work.
import { main } from './lib/runtime.mjs';

await main('stop');
