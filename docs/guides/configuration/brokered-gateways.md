# Brokered gateways

A gateway, a Claude entry with a `baseURL`, takes `auth` to sign in through impd's credential broker
on an imp target. The [brokered credentials guide](./brokered-credentials.md) covers the profiles
`auth` selects, with an example of a brokered gateway, and the
[gateways section](./agents.md#gateways) covers a gateway without `auth`.

An entry's `auth.profiles` selects profiles, and atc adds each one's dependencies.
`auth.placeholderEnv` lists the variables that stand in for the credential, each holding
`imp-broker-placeholder`. atc refuses the entry, leaves it out of the picker, and prints the reason
when the daemon starts, when any of these holds:

- A selected profile or one of its dependencies is missing or refused, or the dependencies form a
  cycle.
- Two profiles in the expanded set send different secrets or rules to one host. atc never picks
  between them by order.
- `baseURL` is not https, has a port or user info, or its host is not one of the expanded profiles'
  hosts.
- Its `settings` set `apiKeyHelper`. A credential helper for launches without the broker goes in the
  entry's own `apiKeyHelper`.
- `auth.args` is not an array of strings.
- `env`, `settings.env`, or `placeholderEnv` sets a proxy or CA variable: `HTTPS_PROXY`,
  `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY`, `SSL_CERT_FILE`, `SSL_CERT_DIR`,
  `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE`, or `CURL_CA_BUNDLE`, in either
  case. impd sets these to route requests through the broker, and a value the session sets wins over
  impd's.
- `env`, `settings.env`, or `placeholderEnv` sets `ANTHROPIC_BASE_URL`, which would replace the
  checked `baseURL`.
- `env` or `settings.env` sets `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, or a variable that
  `placeholderEnv` sets, since the entry's value would replace the placeholder.

atc leaves out a profile that breaks impd's rules for secret names, hosts, or headers, and prints an
error for it, so an entry selecting it is refused as well.

A gateway with `auth` and no `apiKeyHelper` starts only on an imp target whose impd has a broker, in
a session with a broker binding. On every other target, a spawn, a resume, a restore, and an adopt
each fail with `auth_target_unsupported` before any workspace is materialized, any harness starts,
or any imp is touched. The agent picker offers the gateway only the targets with a broker. A
headless turn is refused, and the session has no resume command.

A gateway with both `auth` and `apiKeyHelper` is one entry that you can start on either kind of
target. On a target without a broker, the helper supplies the credential on the daemon's machine,
headless turns run, and a session on the local target has a resume command, as for a gateway without
`auth`. On an imp target, the session takes the broker's credential, and the helper never reaches
the guest. Set `auth.args` when the imp launch needs other arguments, such as a mod folder at
another path: `auth.args` replaces `args` on an imp launch, and `args` applies everywhere else.

On an imp target, the session's guest folder holds a settings file for its binding revision and a
Claude config folder of its own. The settings file points the CLI at `baseURL` with the placeholder
and holds no credential helper. atc seeds the config folder with first-run onboarding state only
when `.claude.json` does not exist. Each launch marks Claude Code's one-time offer to block reads
outside the working directories as seen in `.claude.json`, so an unattended session never waits on
that offer. The mark leaves the block off. Each start names a permission mode: the one the launch's
arguments set, which are `auth.args` when it is set and `args` otherwise, else the one the gateway's
`settings` set, else Claude's manual `default` mode.

With [clone trust](./targets.md#clone-trust) on an imp target, atc seeds trust for the clone's
resolved root in that session's isolated guest config, never in the user's Claude config. atc keeps
an existing guest `.claude.json` and adds only the outside-read offer mark, so its trust decision
takes precedence.

The placeholders must include exactly one of the two variables Claude sends as its credential, and
the profile for the `baseURL` host must set the header Claude sends that variable in:

| Placeholder            | Header Claude sends             | Profile `header` | Profile `scheme` |
| ---------------------- | ------------------------------- | ---------------- | ---------------- |
| `ANTHROPIC_AUTH_TOKEN` | `Authorization: Bearer <value>` | `authorization`  | `bearer`         |
| `ANTHROPIC_API_KEY`    | `x-api-key: <value>`            | `x-api-key`      | `raw`            |

Any other placeholder variable reaches the session as it is, for a tool that runs in it, and a
selected profile for that tool's host lets impd's broker fill it. `CLAUDE_CODE_OAUTH_TOKEN` and
`CLAUDE_CONFIG_DIR` are the exception: Claude reads the first as its own credential beside the
pairing's variable, and the broker never fills the header it feeds, while atc sets the second to the
session's own config folder. Both pairing variables at once, a placeholder whose profile sets the
other pairing's header or scheme, and any other pairing fail with `auth_placeholder_unsupported`, on
every target and before anything is prepared, and `agents.list` lists the gateway as unable to
spawn.

A gateway that runs the auto-mode mod on the daemon's machine with a local key, and on an imp with
its keys held by impd, looks like this:

```json
{
  "authProfiles": {
    "glm": { "secret": "glm", "host": "api.z.ai", "header": "authorization", "scheme": "bearer" },
    "jev": {
      "secret": "jev-imp-agents",
      "host": "api.typesafe.ai",
      "header": "authorization",
      "scheme": "bearer"
    }
  },
  "agents": {
    "glm-auto": {
      "kind": "claude",
      "baseURL": "https://api.z.ai/api/anthropic",
      "args": ["--plugin-dir", "/home/me/.local/share/auto-mode/mods/auto-mode"],
      "apiKeyHelper": "/home/me/.local/bin/glm-key",
      "auth": {
        "profiles": ["glm", "jev"],
        "placeholderEnv": {
          "ANTHROPIC_AUTH_TOKEN": "imp-broker-placeholder",
          "TYPESAFE_API_KEY": "imp-broker-placeholder"
        },
        "args": ["--plugin-dir", "/opt/auto-mode/mods/auto-mode"]
      }
    }
  }
}
```

Add the key to impd as a `custom` secret named `jev-imp-agents` on the host `api.typesafe.ai`, as
impz's
[credential connectors guide](https://github.com/zgeoff/impz/blob/main/docs/guides/connectors.md#secrets-and-grants)
shows, and list `jev-imp-agents` in the `--grantable` list of the target's token.

## API key header

Some backends take the key only in an `x-api-key` header and refuse a request that also carries an
`Authorization` header. Pair such a backend with `ANTHROPIC_API_KEY`, and leave
`ANTHROPIC_AUTH_TOKEN` out, so Claude sends no `Authorization` header. For example, Meta's
`api.meta.ai`:

1. Add the key to impd as a `custom` secret named `muse` on the host `api.meta.ai`, with the header
   `x-api-key` and the scheme `raw`, so impd sets the key alone in that header. List `muse` in the
   `--grantable` list of the target's token.

2. Add the profile and the gateway entry:

   ```json
   {
     "authProfiles": {
       "muse": { "secret": "muse", "host": "api.meta.ai", "header": "x-api-key", "scheme": "raw" }
     },
     "agents": {
       "muse": {
         "kind": "claude",
         "baseURL": "https://api.meta.ai",
         "auth": {
           "profiles": ["muse"],
           "placeholderEnv": { "ANTHROPIC_API_KEY": "imp-broker-placeholder" }
         }
       }
     }
   }
   ```

Claude asks a person whether to use an `ANTHROPIC_API_KEY` it has not seen before, so atc seeds the
session's config folder with the placeholder approved. atc seeds a config folder only when it holds
no `.claude.json`, so a session that started under the bearer pairing asks once when it resumes:
answer yes. A host whose environment sets `ANTHROPIC_AUTH_TOKEN` would add an `Authorization` header
beside the key, so the launch exits with code 78 on such a host, with an error that names the
variable.
