# Releasing

A release happens when someone merges the release PR by hand. release-please keeps one release PR
open on `main`, and each releasable commit that lands updates its version bump and changelog. The
`release` job in `main.yml` calls the shared release-please workflow of `zgeoff/tools` at the repo's
sync tag, with its merge input off, so no workflow merges that PR. The run of the merge tags the
release at once, and once its checks pass, its `ship-release` job attaches the compiled binaries,
pushes the Homebrew formula and publishes `@atcx/contract` to npm. A run that cannot ship the tag it
made dispatches `main.yml` at the tag, and that run ships it. This runbook covers what the
automation does not: its one-time setup, cutting a release, and the recoveries a failed release
needs.

## One-time setup

### The release App

A pull request that `GITHUB_TOKEN` creates or pushes to starts no workflow, so a release PR it
opened would get no CI. The workflow therefore uses a GitHub App token.

1. Create a GitHub App, or reuse `zgeoff-release`, with any homepage URL and the webhook off.
2. Give it read and write access to Contents and to Pull requests, then install it on `zgeoff/atc`.
3. Generate a private key, and add it to the repo settings:
   - the Actions variable `RELEASE_APP_ID`, set to the App's client ID
   - the Actions secret `RELEASE_APP_PRIVATE_KEY`, set to the `.pem` contents
4. In the repo's Actions settings, allow GitHub Actions to create and approve pull requests.

Without the App, the release PR still opens, but no CI runs on it.

### The Homebrew tap

The formula lives in a second repository, `<owner>/homebrew-tap`, under `Formula/atc.rb`.

1. Create the `homebrew-tap` repository, and install the release App on it.
2. Add the Actions variable `HOMEBREW_TAP`, set to `homebrew-tap`, the repository name alone.

Install the App on the tap before you set the variable: with the variable set and the App missing
there, the release job fails when it mints the tap token. With the variable unset, the release job
leaves the formula alone and runs every other step.

### The npm trusted publisher

The release job publishes `@atcx/contract` through npm's trusted publishing, so no npm token exists.
npm takes the job's GitHub identity in place of one, and records where the package was built.

1. On npmjs.com, open the `@atcx/contract` package settings.
2. Add a trusted publisher of type GitHub Actions, with the repository `zgeoff/atc` and the workflow
   file `main.yml`.
3. Run `npm trust list @atcx/contract`. Expect one entry for `zgeoff/atc` and `main.yml`.

npm sets a trusted publisher only on a package that exists, so a new package needs one publish by
hand before step 1.

## Cutting a release

1. Open the release PR, the one release-please opened from the
   `release-please--branches--main--components--@zgeoff/atc` branch, and wait for its checks to
   pass.
2. Squash-merge it. The merge starts the release run on `main`.

## Recovering a release

- **The release PR has no checks.** `RELEASE_APP_ID` is unset, so the release job skipped the App
  token step, and release-please opened the PR with `GITHUB_TOKEN`, which starts no workflow. Set up
  the App, then close and reopen the PR to start its checks.
- **The release job fails before release-please runs, and its error holds a release PR and the
  workflow files changed since its merge.** The release App's token has no Workflows permission, so
  GitHub refuses it a tag on a merge commit that a change to `.github/workflows/` has left behind
  the head of `main`. The job fails on every later run until you recover:
  1. On the merged release PR, replace the label `autorelease: pending` with `autorelease: tagged`.
     release-please then skips that version.
  2. Merge a commit with the footer `Release-As: <next patch version>`.
  3. Merge no pull request that changes `.github/workflows/` until the new release PR has merged and
     its run has tagged it.
- **The release is tagged, but its binaries, formula or npm package are missing.** Run the ship
  steps again at the tag, so the binaries build from the tagged commit:

  ```bash
  gh workflow run main.yml --ref '@zgeoff/atc@<version>'
  ```

  Each step replaces what the failed run left, and the publish skips a version npm holds already. A
  re-run of the failed job does not help when the failure is deterministic, since a re-run uses the
  workflow file of the original commit.

- **A release needs a specific version.** Put `Release-As: <version>` in the footer of a commit that
  lands on `main`. A squash merge takes the footer from the squash body, so pass it there:

  ```bash
  gh pr merge <pr_number> --squash --body 'Release-As: <version>'
  ```
