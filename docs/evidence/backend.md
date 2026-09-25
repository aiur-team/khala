# KHA-102: reusable backend feasibility

Local experiment, 2026-09-17. The candidate is official Synapse 1.161.0 with
Postgres 16, pinned to immutable image digests in
[`compose.yaml`](../../experiments/backend/compose.yaml). The TypeScript experiment
is self-contained; no production service or paid Railway resource was provisioned.

## Observed proof

See [`backend-runtime.json`](backend-runtime.json) for sanitized measurements from
the actual disposable service run. The runner tests two disposable users, private
room membership, synthetic **plaintext** event/history persistence, stable signing
identity, authenticated access after restarting both services, and failed writes
during database unavailability followed by a fresh event write and readback on recovery.
The recovery transaction has a new random ID, so cached history cannot establish
success. Database-down HTTP 5xx rejection is distinguished from timeout/unknown
outcome; the latter does not pass the rejection test.
Those assertions do not establish E2EE, browser compatibility or connector delivery.

Early runs failed readiness: Docker did not publish the client port on an
internal-only network, then reassigned the ephemeral host port on restart. The
runner now adds a separate client bridge, keeps the binding on loopback and
rediscovers the mapping after restart. Simultaneous restart also raced Synapse
against database shutdown; restart now honors database health before Synapse starts.
Finally, cached account identity and cached event reads were insufficient to
establish database recovery, so recovery requires a fresh write and readback.
Failed runs were cleaned up by the runner.

Measurements are a tiny synthetic baseline on a shared development machine, not a
capacity study. Container CPU/memory are one `docker stats` sample, not peak usage;
Postgres disk is `du -sk` of the database volume. Duration includes container startup
and readiness. No price, throughput or production sizing claims follow from them.

## What reuse removes and what remains

| Concern | Synapse/Postgres candidate | Netlify Functions/Blobs alternative |
| --- | --- | --- |
| Durable event IDs, history, room state | Existing OSS service; local persistence proof exercised | Custom acceptance, sequencing, replay, retention and conflict handling |
| Concurrent state updates | Database and Matrix service implementation | Deliberate conditional-write design; reconcile changes spanning objects |
| Realtime/reconnect | Matrix sync interface to integrate | Add realtime broker/transport and reconcile missed notifications |
| Device/key lifecycle | Existing Matrix SDKs to validate in 141/142 | Select vetted crypto stack and integrate key distribution, verification, recovery |
| Operations | Two persistent services, volumes, backups, upgrades, monitoring | Fewer persistent services; custom protocol and broker operations remain |
| Khala policy/session integration | Still custom in narrow TypeScript ports | Still custom in narrow TypeScript ports |

This experiment adds one compose file and one disposable TypeScript runner, with
no production application backend, database schema or custom encryption. Real
integration still needs authentication/admission mapping, SDK clients, the owner's
continuous connector, review policy and harness adapters. Netlify Functions remains
a suitable control-plane candidate; a request-lifetime function cannot own the
continuous connector. No second messaging backend was built for comparison.

The comparison is an engineering inventory, not a measured time-saving percentage.
[Synapse installation](https://element-hq.github.io/synapse/latest/setup/installation.html)
and [Postgres configuration](https://element-hq.github.io/synapse/latest/postgres.html)
were refreshed at implementation. [Netlify Blobs documentation](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)
describes consistency and conditional writes; these are inputs to future control
state design, not evidence that a full channel protocol is already implemented.

## Conditional adoption decision

Continue evaluating OSS Matrix as the messaging substrate: it supplies substantial
existing service behavior while preserving TypeScript application code and Netlify
web/control hosting. This local proof alone does not select production hosting.

| Criterion | Evidence/status |
| --- | --- |
| Local restart retains server/account identity and history | Automated actual-service assertion in runtime record |
| Database unavailable produces failed operation; recovers | Automated actual-service assertion in runtime record |
| Full backup/restore, including signing identity | **Not run**; restart is not restore |
| Browser/headless encrypted peer exchange, device verification and key recovery | Owned by KHA-141/142; **not proven by this plaintext experiment** |
| Connector restart/ownership and actual harness session delivery | Separate 144/integration proofs; **not run here** |
| Railway domain/TLS/volumes/restarts and billing | **Not run/unmeasured**; requires hosting decision |
| License acceptance | Synapse upstream AGPL/commercial choice and PostgreSQL License identified; production decision pending |
| Resource sizing/security/upgrade operations | Small local sample only; production assessment pending |

Reproduce with the commands in [`README.md`](../../experiments/backend/README.md).
No account tokens, database passwords, signing keys or participant messages are
included in the recorded evidence.
