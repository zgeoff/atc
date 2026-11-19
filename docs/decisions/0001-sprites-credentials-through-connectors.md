# 0001: Sprites sessions sign in through connectors

- Date: 2026-11-19
- Status: decided

## Decision

A Sprites session never holds a credential value. The agent's endpoint points at a Sprites
connector's gateway URL, and the agent's token is the placeholder `broker-placeholder`. The gateway
adds the stored credential on the way out. A connector admits a sprite by the start of its name, so
a Sprites target's sprite name prefix is its grant.

## Why

- atc keeps one rule on every remote host: nothing from the daemon's environment, a credential
  included, reaches it ([targets](../architecture/execution/targets.md#starting-a-harness)).
- A sprite's disk persists across sleeps, and any process in the sprite can read a file or an
  environment variable that holds a token.
- Claude Code 2.1.319 in a sprite answered through a Custom API connector with `ANTHROPIC_BASE_URL`
  set to the gateway URL and `ANTHROPIC_AUTH_TOKEN=broker-placeholder`, streaming server-sent
  events. A sprite whose name the connector's policy did not admit got HTTP 403.

## Rejected alternatives

| Option                                                      | Why not                                                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| pass the token in the exec's environment                    | the token sits in the sprite, readable by any process there, for the life of the harness                 |
| the user signs in inside each sprite                        | each session gets a new sprite, so each session needs a sign-in, and the token sits on the sprite's disk |
| atc proxies model traffic from the sprite through the relay | every token streams through the daemon's link, and a daemon restart stalls the agent's requests          |
| model Sprites as a `CredentialBroker` with per-host grants  | Sprites has no grant per sprite and no revoke, so the broker's revoke would stay pending forever         |

## Consequences

- atc cannot revoke or rebind a Sprites session's credentials. The owner changes a connector's
  access policy in Sprites.
- Every sprite a target creates gets every connector that admits the target's prefix. A second set
  of credentials needs a second target with its own prefix.
- Codex runs on a Sprites target only once its backend has a connector route.
