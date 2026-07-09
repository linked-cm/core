---
summary: How @_linked/core is released to npm — the dev → main → release-PR → publish gitflow, driven by Changesets and the Publish workflow. Agent-facing; run only with explicit user consent.
packages: [core]
---

# Publishing / release

> **Consent gate (agents):** Releasing is an outward-facing, hard-to-reverse action — it
> publishes to npm and moves `main`. **Do not push, merge release PRs, or publish unless the
> user explicitly asks for it in this session.** Preparing a changeset and drafting PRs is fine;
> merging and publishing are not, without a clear go-ahead.

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
| `main` (no changesets pending) | **Publish Stable Release** | `npx changeset publish` → publishes the stable version to npm (`latest`), then... |
| `main` (after publish) | **Back-merge main into dev** | Auto-opens & auto-merges a `main → dev` PR so `dev` picks up the version bump, CHANGELOG, and changeset deletions (prevents re-releasing consumed changesets). |

So a stable release takes **two** pushes to `main`: the first opens the version PR; merging that
version PR is the second push, which actually publishes.

## Release runbook (with consent)

Assuming the fix is on a branch with a changeset, and the user has asked to deploy:

```bash
# 1. Land the change on dev
gh pr create --base dev --head <branch> --title "..." --body "..."
gh pr checks <pr> --watch          # wait for green
gh pr merge <pr> --merge
gh run watch <dev-publish-run-id>  # dev prerelease publishes (tag: next)

# 2. Promote dev -> main
gh pr create --base main --head dev --title "release: ..." --body "..."
gh pr checks <pr> --watch
gh pr merge <pr> --merge
gh run watch <main-run-id>         # release job opens the Version Packages PR

# 3. Merge the auto-created release PR ("chore: version package for release")
gh pr list --base main --head changeset-release/main --state open
gh pr checks <release-pr> --watch
gh pr merge <release-pr> --merge   # this push publishes the stable release
gh run watch <publish-run-id>

# 4. Confirm
npm view @_linked/core dist-tags   # latest should be the new version
gh pr list --base dev --head main --state all  # back-merge PR auto-merged, dev clean
```

## Verifying a release

- `npm view @_linked/core version` / `npm view @_linked/core dist-tags` — `latest` is the new
  stable; `next` is the most recent dev prerelease.
- `git show origin/main:package.json` and `origin/dev:package.json` should agree on the version
  after the back-merge.
- No consumed changesets left on `dev`: `git ls-tree --name-only origin/dev .changeset/` should
  show only `README.md` and `config.json`.

## Notes & gotchas

- The version PR and back-merge run as an org **GitHub App** (secrets `RELEASE_APP_ID` /
  `RELEASE_APP_PRIVATE_KEY`) so their CI runs without a manual approval gate.
- The combined bump is the **highest** level among all pending changesets (any `minor` ⇒ minor).
- A leftover changeset for already-released work would trigger an unwanted re-release; the
  post-release back-merge deletes consumed changesets on `dev` to prevent this.
- Auto-merge of the back-merge PR requires "Allow auto-merge" on the repo; otherwise it is left
  open for a manual merge.
