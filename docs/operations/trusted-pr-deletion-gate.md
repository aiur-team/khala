# Trusted PR deletion status rollout

Khala's existing required `deletion-guard` job requires an admin approval on
the current PR head when a PR removes any file. Keep that check. It is a
separate policy from the 50-file ceiling described here.

`trusted-pr-deletions.yml` runs on `pull_request_target` from the protected
base. Its checkout pins the event's base SHA. It fetches the PR head as Git
data, verifies the event head SHA, and counts net deleted files from merge
base to PR head. It never checks out or executes PR-head files. More than 50
net file deletions fail regardless of review.

The workflow publishes `khala/trusted-pr-deletions` as a commit status on the
**PR head SHA** from a dedicated GitHub App. The Actions job alone is not the
required status: a `pull_request_target` job does not provide the head-commit
status that branch protection must require. A missing token, fetch failure,
moved PR ref, or failed status post cannot produce success.

## Activation

1. Merge the reviewed workflow and script into protected `main` before making
   its new status required. Existing `validate` and `deletion-guard` checks
   stay required throughout rollout.
2. Create a dedicated GitHub App with **Commit statuses: Read and write** and
   install it only on `aiur-team/khala`. Set repository variable
   `KHALA_DELETION_GUARD_APP_CLIENT_ID` to its Client ID and repository secret
   `KHALA_DELETION_GUARD_APP_PRIVATE_KEY` to its private key. The workflow
   requests only `permission-statuses: write` for the installation token;
   checkout uses a separate read-only `GITHUB_TOKEN`.
3. Open a disposable PR with 51 real file deletions. Confirm a **failure**
   status on its exact head SHA, authored by that App. Check a PR with 50
   deletions and a fork PR with no deletions for success. Check the checkout
   log names the protected base SHA and no PR-head checkout occurs.
4. Add `khala/trusted-pr-deletions` to `main` branch protection's required
   checks, bound to the **dedicated App ID** (`app_id` in the protection API),
   not the GitHub Actions App ID. Preserve the existing `validate` and
   `deletion-guard` contexts and the current `strict: false` setting. Do not
   permit an arbitrary source for this context.
5. From an actor without branch-protection bypass, verify the 51-deletion PR
   is unmergeable and the 50-deletion PR can merge when other required checks
   and reviews pass. A bypass actor can override branch protection and must
   respect the same policy operationally.

The workflow reacts to PR creation, head changes, reopening, base-target
edits, and ready-for-review transitions. Normal fast-forward changes to
protected `main` do not change the merge base of a fixed PR head, so the
deletion count remains the same under the existing non-strict policy. Revisit
this assumption if `main` becomes rewritable or its required-check policy
changes.

Until the App installation, App-bound required status, and blocked-PR proof
are complete, this workflow is staged code rather than active enforcement.
