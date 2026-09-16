# Platform planning evidence

Read-only research on 2026-09-16. No application tests, service deployment, restore or performance benchmark was run during planning.

| Source | Verified fact | Planning consequence |
|---|---|---|
| Khala base `6d4694173eff9b0832f4c3a2cdb90b4281fcccd9` | Initial commit has README; app implementation is absent | Proposed paths are new, and future commands must be supplied by their owning tickets |
| Archon `c7d3254097acaa02eed1e3be6fd8fbf06c0e8128`, `package.json` | Node >=22.15, Netlify Blobs 11.0.2 and jose6.1.0 | Start from a supported Node22 runtime family; verify exact versions for Khala rather than copying a tested claim |
| Archon `netlify.toml` | One build/publish surface, explicit function directory, separate preview context, host-aware edge security ownership | Khala packages one web/control deployment; CSP ownership must be explicit and match Khala's actual SDK needs |
| [Netlify function configuration](https://docs.netlify.com/build/functions/configuration/) | Synchronous execution is bounded to 60 seconds; background execution to 15 minutes | Continuous agent subscriptions must run on the owner host |
| [Netlify monorepos](https://docs.netlify.com/build/configure-builds/monorepos/) | Base directory governs installation/build and publish path resolution | Build from workspace root and specify app output explicitly |
| [Synapse installation](https://element-hq.github.io/synapse/latest/setup/installation.html) | Official container is available; durable server name is an identity choice | Reuse container, require stable server identity before durable production boot |
| [Synapse PostgreSQL](https://element-hq.github.io/synapse/latest/postgres.html) | Documented database encoding and locale constraints apply | Reject an incorrectly initialized production DB rather than using a bypass flag |
| [Synapse backup guidance](https://element-hq.github.io/synapse/latest/usage/administration/backups.html) | Server backup includes identity/configuration as well as database/media concerns | Verify a complete recovery set; DB restore alone does not establish recoverability |
| [Railway backups](https://docs.railway.com/volumes/backups) | Restore is restricted to same project/environment; wiping a volume removes its backups | Do not mistake a provider snapshot for a portable disaster-recovery export |
| [Node release schedule](https://nodejs.org/en/about/previous-releases) | Node22 and24 are maintained LTS lines at research time | Choose maintained exact patch with SDK/native/platform support, not an EOL runtime |

## Confidence/deepening disposition

The highest-risk sections were deployment identity, function lifetime, backup portability, and source-versus-proposed-path claims. Official docs changed the plans: preserve Synapse server_name, keep live subscriptions out of Functions, use an isolated logical restore proof, and label unrun commands as implementation-time contracts. Exact SDK/runtime/image tuples remain execution evidence to be recorded by the feasibility owners; none are falsely marked tested.

KHA-140 keeps root acceptance separate from leaf closure. KHA-101 keeps fixture discovery out of production exports. KHA-131 preserves route-specific API errors rather than rewriting all requests to the SPA. Independent review follows drafting; this evidence note is not that review.

Deeper control-state review: Netlify site-wide Blobs are available across deploy contexts, so namespace separation is not a security boundary. KHA-131 now owns the actual guarded ControlStore adapter (contract105), strong ETag reads, conditional writes, uncertain-outcome readback, and isolated live CAS proof; untrusted previews require a separate site/credential boundary.
