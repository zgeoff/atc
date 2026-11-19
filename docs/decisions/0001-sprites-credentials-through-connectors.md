# 0001: Sprites sessions take credentials from Sprites connectors

- Date: 2026-11-19
- Status: decided

## Decision

A Claude session that atc runs on Sprites never holds a credential value. A Sprites connector holds
it, and Sprites adds it to each request outside the sprite.

- [Sprites](https://docs.fly.io/sprites) runs each atc session in a sprite, a persistent Linux VM on
  Fly.io. In atc, a Sprites target is a config entry with `"provider": "sprites"`.
- The user stores each credential once, in a Sprites connector of the Custom API kind. Each
  connector has a gateway URL of its own. Sprites forwards a request sent to that URL to the API,
  and replaces the request's `authorization` header with the stored credential.
- atc starts the Claude CLI in the sprite with `ANTHROPIC_BASE_URL` set to the connector's gateway
  URL, and `ANTHROPIC_AUTH_TOKEN` set to `broker-placeholder`. The Claude CLI sends
  `ANTHROPIC_AUTH_TOKEN` as its `authorization` header, so the placeholder is the value that Sprites
  replaces. atc's imp sessions send the same value, for impd's broker to replace.
- Each connector has an access policy. The user sets the policy's name prefix, and Sprites lets a
  sprite use the connector only when the sprite's name starts with that prefix. atc starts the name
  of every sprite on a target with the target's `spritePrefix` config key. So the policies that the
  user sets decide which connectors the sessions on a target can use.

## Why

- atc keeps one rule on every remote host: nothing from the daemon's environment reaches it, a
  credential included
  ([Execution targets](../architecture/execution/targets.md#starting-a-harness)).
- A sprite keeps its disk across sleeps, and any process in the sprite can read a file or an
  environment variable that holds a token.
- A check by hand on 2026-11-19 ran Claude Code 2.1.319 in a sprite through a Custom API connector,
  with `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` set as in the Decision. Claude answered, and
  the reply streamed as server-sent events. A sprite whose name the connector's policy did not admit
  got HTTP 403.

## Rejected alternatives

| Option                                                                                                                                                                              | Why not                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| atc passes the token in the environment of the command that starts the agent                                                                                                        | the token sits in the sprite, readable by any process there, for as long as the agent runs                                                                                                                       |
| the user signs in inside each sprite                                                                                                                                                | each session gets a new sprite, so each session needs its own sign-in, and the token sits on the sprite's disk                                                                                                   |
| atc forwards the agent's API traffic through its own connection to the sprite                                                                                                       | every model response streams through the daemon's machine, and a daemon restart stalls the agent's requests                                                                                                      |
| atc drives Sprites through its [broker contract](../architecture/execution/runtime-auth.md#revoke-and-rebind), which grants a secret to one host and revokes it when a session ends | Sprites lets every sprite whose name starts with the prefix use a connector, and cannot take a connector from one sprite. atc's revoke waits until the host no longer holds the grant, so it would wait for ever |

## Consequences

- atc cannot revoke one Sprites session's credentials, or move one session to other credentials. To
  cut access, the user changes a connector's access policy in Sprites. That change cuts every
  session on each target whose sprites the policy admitted.
- A target can use several connectors, one for each API its agents call. Every sprite on the target
  can use every connector whose policy admits the target's prefix. A session that needs other
  credentials runs on a second target with a prefix of its own.
- A connector puts one fixed credential in each request, and cannot refresh a sign-in that expires.
  So an agent that signs in with a refreshing sign-in, such as Codex with a ChatGPT sign-in, does
  not run on a Sprites target.
