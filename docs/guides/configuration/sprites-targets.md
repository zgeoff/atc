# Sprites targets

A `sprites` target runs each Claude session in a sprite of its own, a persistent Linux VM on
[Fly.io Sprites](https://docs.fly.io/sprites). Your Anthropic credential never enters the sprite.
You store it in a Sprites connector: a Sprites object with a gateway URL of its own, which adds the
credential to each request it forwards to the Anthropic API.

Before you start, check these:

- The daemon runs a compiled release binary, because atc uploads that binary into each sprite. A
  daemon run from source lists the target as unavailable in the spawn picker, with the problem
  `compiled_binary_required`.
- You run Claude on the target. The daemon refuses every other agent on it with the problem
  `route_required`, because only Claude can send its requests to a connector's gateway URL.

## Create the connector

1. In the Sprites dashboard, create a connector of the Custom API kind for
   `https://api.anthropic.com`, and store your Anthropic credential in it.
2. Set the connector's access policy name prefix to the `spritePrefix` you give the target in
   [Configure the target](#configure-the-target), such as `atc-`. Sprites lets a sprite use the
   connector only when the sprite's name starts with that prefix, and atc starts the name of every
   sprite on the target with `spritePrefix`.
3. Copy the connector's id from the dashboard.

At each spawn, the daemon reads your connectors before it creates a sprite. It refuses the spawn
with the problem `route_missing` when the connector is gone, when its policy has no name prefix, or
when `spritePrefix` does not start with the policy's prefix. A policy prefix shorter than
`spritePrefix`, such as `atc` for `atc-`, also lets the sprites use the connector.

## Create the org token

1. In the Sprites dashboard, create an API token for your org. The token has the form
   `<org>/<token id>/<secret>`: your org's slug, the token's id, and its secret.
2. Give the daemon the token in either of these:
   - an environment variable of the daemon, such as `SPRITES_TOKEN`;
   - a file that only your user can read: `chmod 600 <token file>`.

## Configure the target

Add the target, an auth profile for the connector, and an agent entry that uses the profile:

```json
{
  "targets": {
    "sprites": { "provider": "sprites", "tokenEnv": "SPRITES_TOKEN", "spritePrefix": "atc-" }
  },
  "authProfiles": {
    "claude-sprites": {
      "secret": "<connector id>",
      "host": "api.anthropic.com",
      "header": "authorization",
      "scheme": "bearer"
    }
  },
  "agents": {
    "claude-sprites": { "kind": "claude", "auth": { "profiles": ["claude-sprites"] } }
  }
}
```

| Key            | Default                   | What it does                                        |
| -------------- | ------------------------- | --------------------------------------------------- |
| `tokenEnv`     | unset                     | the daemon's variable that holds the org token      |
| `tokenFile`    | unset                     | the file that holds the org token                   |
| `spritePrefix` | `atc-`                    | the start of every sprite name on the target        |
| `apiURL`       | `https://api.sprites.dev` | the Sprites API                                     |
| `guestDir`     | `/home/sprite/.atc`       | the folder in each sprite that atc's files go under |

- Set exactly one of `tokenEnv` and `tokenFile`. The daemon refuses a config that sets both or
  neither.
- Put the connector's id in the profile's `secret`. Copy `host`, `header` and `scheme` from the
  example: the profile schema needs them, but the connector's own settings decide the header it
  sets.
- Give the profile to its own agent entry, such as `claude-sprites` above. A profile on your main
  `claude` entry follows Claude to every target.
- Give each Sprites target a prefix that does not start with another Sprites target's prefix. The
  daemon refuses a config with `atc-` and `atc-work-`, and names both targets. A connector that
  admits `atc-` would also admit every `atc-work-` sprite.
- When the token variable is unset or empty, or the token file is missing or empty, the spawn picker
  lists the target as unavailable, with the variable's name or the file's path.

A change to `tokenEnv`, `tokenFile`, `spritePrefix`, `apiURL` or `guestDir` makes the daemon treat
the target as new, and it no longer finds the sprites of the old settings. List them with
`sprite list`, and delete each with `sprite destroy -s <sprite name>`.

## Check the setup

1. Restart the daemon, so it reads the new config.
2. In the spawn picker, pick the `claude-sprites` agent and the `sprites` target. Expect: the
   session starts and answers. The first spawn on a new sprite takes longer, while atc uploads its
   binary.
3. Run `sprite list`. Expect: one sprite whose name starts with `spritePrefix`.

## What a kill and a forget do

- A kill detaches atc from the session's sprite. The sprite sleeps about 10 seconds later, with
  Claude frozen inside.
- A revive attaches to Claude again, with its screen and its conversation. When the sprite lost its
  memory during the sleep and booted again, the revive starts Claude with its resume command, which
  reloads the conversation from its transcript.
- A forget deletes the sprite.

To cut a session's access, change or delete the connector's access policy in Sprites. That cuts
every session on every target whose `spritePrefix` the policy admits, because atc cannot revoke one
session's credential. The [architecture doc](../../architecture/execution/sprites-provider.md)
covers the objects in a sprite and each refusal.
