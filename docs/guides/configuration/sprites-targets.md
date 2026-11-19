# Sprites targets

A `sprites` target runs each Claude session in a sprite of its own, a persistent Linux VM on
[Fly.io Sprites](https://docs.fly.io/sprites). Your Anthropic credential never enters the sprite.
You store it in a Sprites connector: a Sprites object that forwards each request to the Anthropic
API and adds the credential on the way.

Check these before you start:

- The daemon runs a compiled release binary, because atc uploads that binary into each sprite. A
  daemon run from source lists the target as unavailable in the spawn picker, with the problem
  `compiled_binary_required`.
- You run Claude on the target. The daemon refuses every other agent on it with the problem
  `route_required`, because only Claude can send its requests through a connector.
- The [`sprite` CLI](https://docs.fly.io/sprites) is installed and logged in to your org. You use it
  to check the setup and to delete sprites.

## Create the connector

1. In the Sprites dashboard, create a connector of the Custom API kind for
   `https://api.anthropic.com`.
2. Store your Anthropic API key in the connector.
3. In the connector's access policy, set the name prefix to the `spritePrefix` you give the target,
   such as `atc-`. Sprites lets a sprite use the connector only when the sprite's name starts with
   the policy's prefix, and atc starts the name of every sprite on the target with `spritePrefix`.
4. Copy the connector's id from the dashboard.

At each spawn, the daemon reads your connectors before it creates a sprite. It refuses the spawn
with the problem `route_missing` when the connector is gone, when its policy has no name prefix, or
when `spritePrefix` does not start with the policy's prefix. A policy prefix that is the start of
`spritePrefix`, such as `atc` for `atc-`, works too.

## Create the org token

1. In the Sprites dashboard, create an API token for your org, and copy the whole token. It has the
   form `<org>/<token id>/<secret>`. Give atc all three parts as one value.
2. Give the daemon the token in either of these:
   - an environment variable of the daemon, such as `SPRITES_TOKEN`;
   - a file that only your user can read: `chmod 600 <token file>`.

## Configure the target

Add these three entries to `~/.config/atc/config.json`:

- a target of the `sprites` provider;
- an auth profile, the entry in `authProfiles` that tells atc which credential a session uses;
- an agent entry for Claude that uses the profile.

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
- Give the profile to an agent entry of its own, such as `claude-sprites`. A profile on your main
  `claude` entry goes with Claude to every target: a Docker target refuses the session, and an imp
  target looks for an impd secret named after the connector's id.
- Give each Sprites target a prefix that does not start with another Sprites target's prefix. The
  daemon refuses a config with `atc-` and `atc-work-`, and its error names both targets. A connector
  for `atc-` would also serve every `atc-work-` sprite.
- When the token variable is unset or empty, or the token file is missing or empty, the spawn picker
  lists the target as unavailable, with the variable's name or the file's path.

The daemon builds a target's identity from `tokenEnv`, `tokenFile`, `spritePrefix`, `apiURL` and
`guestDir`, because each one can point a session at another sprite. After you change one, the daemon
refuses each existing session on the target with `target_changed`, and their sprites stay in your
org. List them with `sprite list`, and delete each with `sprite destroy -s <sprite name>`.

## Check the setup

1. Restart the daemon, so it reads the new config.
2. In the spawn picker, pick the `claude-sprites` agent and the `sprites` target. Expect: the
   session starts and answers. The first spawn takes longer, while atc uploads its binary.
3. Run `sprite list`. Expect: one sprite whose name starts with `spritePrefix`.

## Kill, revive and forget

- A kill detaches atc from the session's sprite. Sprites puts the sprite to sleep, with Claude
  frozen inside.
- A revive attaches to Claude again, with its screen and its conversation. Sprites can drop a
  sleeping sprite's memory, and the sprite then boots again on its next wake. In that case the
  revive starts Claude with its resume command, which reloads the conversation from its transcript.
- A forget deletes the sprite.

To cut one session's access, forget the session. To cut every session's access at once, change or
delete the connector's access policy in Sprites. That cuts each session on each target whose
`spritePrefix` starts with the policy's prefix. The
[architecture doc](../../architecture/execution/sprites-provider.md) covers the files in a sprite
and each refusal.
