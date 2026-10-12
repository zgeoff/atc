# Releasing

A release happens when someone merges the release PR by hand. release-please keeps one release PR
open on `main`, and each releasable commit that lands updates its version bump and changelog. No
workflow merges that PR. Its merge tags the release, attaches the compiled binaries, pushes the
Homebrew formula and opens the agent image pin PR in zgeoff/cloud. `main.yml` holds every step. This
runbook covers what the automation does not: its one-time setup, cutting a release, and the
recoveries a failed release needs.

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

### The agent image pin

The imp agent image in zgeoff/cloud bakes in atc, and each release opens or updates one pin PR
there. Install the release App on `cloud`. cloud's `docs/runbooks/agent-image.md` covers the rest.

## Cutting a release

1. Open the release PR, the one release-please opened from the
   `release-please--branches--main--components--@zgeoff/atc` branch, and wait for its checks to
   pass.
2. Squash-merge it. The merge starts the release run on `main`.

## Recovering a release

- **The release is tagged, but its binaries, formula or pin PR are missing.** Run the release steps
  again for the current version:

  ```bash
  gh workflow run main.yml
  ```

  Each step replaces what the failed run left. A re-run of the failed job does not help when the
  failure is deterministic, since a re-run uses the workflow file of the original commit.

- **A release needs a specific version.** Put `Release-As: <version>` in the footer of a commit that
  lands on `main`. A squash merge takes the footer from the squash body, so pass it there:

  ```bash
  gh pr merge <pr_number> --squash --body 'Release-As: <version>'
  ```
