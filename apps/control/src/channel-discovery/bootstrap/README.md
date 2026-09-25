# Channel discovery bootstrap

This module authorizes an already-running, server-verified native agent session
to discover external channels. The owner consent route issues a one-time PKCE
code; the agent token route exchanges it for a five-minute, Ed25519 DPoP-bound
credential and rotates that credential with per-slot compare-and-set.

The dependency surface is intentionally side-effect free: it accepts auth,
session inspection, storage, trusted-source, and limiter ports only. It has no
channel, membership, admission, device, binding, or adapter-capability port.
Stored records contain purpose-separated digests and fixed binding metadata;
plaintext credential values appear only in successful responses.
