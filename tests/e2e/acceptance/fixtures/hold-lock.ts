// Child process for lock.test.ts: takes the acceptance lock, reports, and holds it
// until killed. Its death must release the lock.

import { hostLock } from '../../../../scripts/acceptance/lock';

const [stateHome, repository] = process.argv.slice(2);
const lock = await hostLock(stateHome!).acquire(repository!);
process.stdout.write(lock ? 'held\n' : 'busy\n');
setInterval(() => {}, 1_000);
