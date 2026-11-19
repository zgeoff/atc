# Sprites targets

A `sprites` target runs each Claude session in a sprite of its own on
[Fly.io Sprites](https://docs.fly.io/sprites). No credential enters the sprite: a Sprites connector
holds your Anthropic credential and adds it to each request outside the sprite.

The daemon must be a compiled release binary, because each sprite runs it. A daemon run from source
lists the target as unavailable with the problem `compiled_binary_required`. Codex and the other
agents are refused on the target with the problem `route_required`, because only Claude has a route.

## Create the connector

1. In the Sprites dashboard or API, create a connector of the Custom API kind for
   `https://api.anthropic.com`, and store your Anthropic credential in it.
2. Set the connector's access policy name prefix to the `spritePrefix` of the target, such as
   `atc-`. Sprites lets a sprite use the connector only when the sprite's name starts with the
   prefix, and atc starts every sprite name on the target with `spritePrefix`.
3. Copy the connector's id, which looks like `conn_...`.

A spawn fails with `route_missing` while the connector is missing, has no name prefix, or has a
prefix that `spritePrefix` does not start with.

## Create the org token

Create a Sprites org token in the form `<org>/<id>/<secret>`, and make it available to the daemon
through an environment variable or a file that only you can read.

## Configure the target

```json
{
  "targets": {
    "sprites": { "provider": "sprites", "tokenEnv": "SPRITES_TOKEN", "spritePrefix": "atc-" }
  },
  "authProfiles": {
    "claude-sprites": {
      "secret": "conn_example_claude",
      "host": "api.anthropic.com",
      "header": "authorization",
      "scheme": "bearer"
    }
  },
  "agents": { "claude": { "auth": { "profiles": ["claude-sprites"] } } }
}
```

| Key            | Default                   | What it does                                        |
| -------------- | ------------------------- | --------------------------------------------------- |
| `tokenEnv`     | unset                     | the daemon's variable that holds the org token      |
| `tokenFile`    | unset                     | the file that holds the org token                   |
| `spritePrefix` | `atc-`                    | the start of every sprite name on the target        |
| `apiURL`       | `https://api.sprites.dev` | the Sprites API                                     |
| `guestDir`     | `/home/sprite/.atc`       | the folder in each sprite that atc's files go under |

- Set exactly one of `tokenEnv` and `tokenFile`. The config is refused with both or neither.
- The profile's `secret` holds the connector's id. Its `host`, `header` and `scheme` stay as the
  profile schema needs them, and the connector's own settings decide the header.
- Give each Sprites target a `spritePrefix` that no other Sprites target's prefix starts with. The
  config refuses the pair and names both targets.
- A target with an unset or empty token lists as unavailable, with the variable's name or the file's
  path in the problem.
- A change to `tokenEnv`, `tokenFile`, `spritePrefix`, `apiURL` or `guestDir` makes a new target.
  The old target's sprites stay in your org, and you delete them with the `sprite` CLI.

## What a kill and a forget do

A kill detaches atc from the session's sprite, and the sprite sleeps about 10 seconds later with the
harness frozen inside. A revive attaches to it again. When the sprite booted again meanwhile, the
revive starts the agent's resume command. A forget deletes the sprite.

atc cannot revoke one session's credentials. To cut access, change the connector's access policy in
Sprites, which cuts every session on each target that the policy admitted. The
[architecture doc](../../architecture/execution/sprites-provider.md) covers the objects and the
refusals.
