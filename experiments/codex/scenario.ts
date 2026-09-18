import { runAttachmentProbe, type ProbeInput } from './probe.js';

const help = `Usage: npm run probe -- --help
       npm run probe -- --stdin < explicit-target.json

JSON input: {"sessionId":"<UUID>","expectedWorkdir":"<absolute path>",
 "nonce":"release-nonce-7","mode":"idle","deadlineMs":5000,
 "socketPath":"<optional absolute control socket>","release":false}

Default: read-only preflight. release:true sends one synthetic approved nonce to
an explicitly designated disposable existing session. It never starts/resumes a
thread, changes permissions, or retries. The prior marker is never transmitted.
Output is a JSON report; an inconclusive report does not establish support.
See README.md for missing live-fixture gates. No credentials or plaintext args.
`;
if (process.argv.length === 3 && process.argv[2] === '--help') {
  console.log(help);
} else if (process.argv.length === 3 && process.argv[2] === '--stdin') {
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => process.stdin.destroy(new Error('input_timeout')), 5000);
    try {
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > 16_384) throw new Error('input_too_large');
        chunks.push(Buffer.from(chunk));
      }
    } finally { clearTimeout(timer); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProbeInput;
    console.log(JSON.stringify(await runAttachmentProbe(input), null, 2));
  } catch {
    console.error('Probe input or execution failed; no raw input/error is printed. See --help.');
    process.exitCode = 1;
  }
} else {
  console.error(help);
  process.exitCode = 1;
}
