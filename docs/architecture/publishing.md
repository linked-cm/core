---
summary: How @_linked/core is released to npm — the hands-free dev → main → auto-published gitflow, driven by Changesets and the Publish workflow. Agent-facing; run only with explicit user consent.
packages: [core]
---

# Publishing / release

> **Consent gate (agents):** Releasing is an outward-facing, hard-to-reverse action — it
> publishes to npm and moves `main`. **Do not push, merge release PRs, or publish unless the
> user explicitly asks for it in this session.** Preparing a changeset and drafting PRs is fine;
> merging and publishing are not, without a clear go-ahead.
>
> Note the release is now **fully hands-free**: merging `dev → main` is the only manual step. The
> bot handles the version PR and publish from there, so a `dev → main` merge *is* a release.

## Branch model

- `dev` — integration branch. Every push publishes a **prerelease** to npm under the `next`
  dist-tag (`X.Y.Z-next.<timestamp>`).
- `main` — stable branch. Releases are cut here via Changesets.
- Feature / fix branches merge into `dev` first.

Every code change that affects the published package must ship a **changeset** in `.changeset/`
(YAML frontmatter with `"@_linked/core": patch|minor|major`, then a user-facing description).
The `changeset-check` CI job enforces this on PRs.

## The pipeline (`.github/workflows/publish.yml`)

The `Publish` workflow triggers on push to `dev` and `main`:

| Ref pushed | Job | Effect |
|---|---|---|
| `dev` | **Publish Dev Release** | Computes next version from `main` + pending changesets, appends `-next.<timestamp>`, `npm publish --tag next`. |
| `main` (changesets pending) | **Publish Stable Release** (`changesets/action`) | Opens/updates the **"chore: version package for release"** PR (branch `changeset-release/main`) that bumps `package.json`, writes `CHANGELOG.md`, and deletes the consumed changesets. Does **not** publish yet. |
| `main` (changesets pending) | **Merge the version PR to publish** | Same run **direct-merges** that version PR using the org release App (`linked-cm-release-bot`), retrying (up to ~10 min) until the required **"Build & Test"** check is green. No human clicks — the App itself merges it. The resulting push to `main` re-triggers the workflow. |
| `main` (no changesets pending) | **Publish Stable Release** | `npx changeset publish` → publishes the stable version to npm (`latest`), then... |
| `main` (after publish) | **Back-merge main into dev** | Auto-opens & auto-merges a `main → dev` PR so `dev` picks up the version bump, CHANGELOG, and changeset deletions (prevents re-releasing consumed changesets). |

So a stable release still takes **two** pushes to `main`: the first opens the version PR, the
second (the bot's merge of that PR) actually publishes. Both are automatic — the only thing a
human does is merge `dev → main`; everything after that is hands-free.

### Why check-only branch protection on `main`, not a required review

`main`'s branch protection is **check-only**: it requires the **"Build & Test"** status check but
**no required review**. This is deliberate and load-bearing for the hands-free flow. A classic
required *review* on `main` is **incompatible** with the bot merge: GitHub's
`bypass_pull_request_allowances` is **not honored** by auto-merge *or* by the App's direct merge, so
the version PR would hang forever on `REVIEW_REQUIRED`. The App can be granted the bypass, but it
simply doesn't take effect for these merge paths — hence check-only. Relatedly, the workflow uses a
**direct merge** (`gh pr merge --merge`), *not* GitHub's `--auto` queue, precisely because
auto-merge ignores the bypass; the required status check is still enforced (not bypassable), so the
step retries until it goes green.

## Release runbook (with consent)

Assuming the fix is on a branch with a changeset, and the user has asked to deploy:

```bash
# 1. Land the change on dev
gh pr create --base dev --head <branch> --title "..." --body "..."
gh pr checks <pr> --watch          # wait for green
gh pr merge <pr> --merge
gh run watch <dev-publish-run-id>  # dev prerelease publishes (tag: next)

# 2. Promote dev -> main  — this is the LAST manual step
gh pr create --base main --head dev --title "release: ..." --body "..."
gh pr checks <pr> --watch
gh pr merge <pr> --merge

# The rest is automatic: the release job opens the "chore: version package for release" PR and
# the bot direct-merges it once "Build & Test" is green → publish → back-merge main into dev.

# 3. Confirm
npm view @_linked/core dist-tags   # latest should be the new version
```

## Verifying a release

- `npm view @_linked/core version` / `npm view @_linked/core dist-tags` — `latest` is the new
  stable; `next` is the most recent dev prerelease.
- `git show origin/main:package.json` and `origin/dev:package.json` should agree on the version
  after the back-merge.
- No consumed changesets left on `dev`: `git ls-tree --name-only origin/dev .changeset/` should
  show only `README.md` and `config.json`.

## Notes & gotchas

- The version PR, its **bot merge**, and the back-merge all run as the org **GitHub App**
  (`linked-cm-release-bot`; secrets `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`) so their CI runs
  without a manual approval gate and the App can merge the version PR itself.
- The "Merge the version PR to publish" step uses a **direct** `gh pr merge --merge` (not `--auto`)
  and retries until "Build & Test" is green; see [Why check-only, not required
  review](#why-check-only-branch-protection-on-main-not-a-required-review) for why `main` is
  check-only.
- The combined bump is the **highest** level among all pending changesets (any `minor` ⇒ minor).
- A leftover changeset for already-released work would trigger an unwanted re-release; the
  post-release back-merge deletes consumed changesets on `dev` to prevent this.
- Auto-merge of the back-merge PR requires "Allow auto-merge" on the repo; otherwise it is left
  open for a manual merge.
