# Brokered credentials

An `authProfiles` entry holds a reference to a secret impd holds and the rule impd's credential
broker applies with it, so a session on an imp reaches a service while the credential stays on the
host. [Brokered gateways](./brokered-gateways.md),
[Claude subscription on imps](./claude-subscription.md), and
[Codex subscription on imps](./codex-subscription.md) cover the agent entries that select profiles.

A gateway entry with `auth` selects the credentials that impd's credential broker adds, on the
host's side, to requests an imp sends to the backend. The config holds secret names, never a value:

```json
{
  "authProfiles": {
    "glm": {
      "secret": "glm",
      "host": "api.z.ai",
      "header": "authorization",
      "scheme": "bearer",
      "dependencies": []
    }
  },
  "agents": {
    "glm": {
      "kind": "claude",
      "baseURL": "https://api.z.ai/api/anthropic",
      "auth": {
        "profiles": ["glm"],
        "placeholderEnv": { "ANTHROPIC_AUTH_TOKEN": "imp-broker-placeholder" }
      },
      "env": { "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-4.6" }
    }
  }
}
```

Each profile in `authProfiles` holds a reference to a secret impd holds and the rule impd applies
with it:

| Key            | What it holds                                                                             |
| -------------- | ----------------------------------------------------------------------------------------- |
| `secret`       | The name of the secret in impd, under impd's secret name rule.                            |
| `host`         | The exact host impd adds the credential for: lowercase, no port, no wildcard, no IP.      |
| `header`       | The lowercase header impd sets, such as `authorization`.                                  |
| `scheme`       | How impd renders the value: `bearer`, or `raw` for the value alone. atc binds these two.  |
| `kind`         | The kind of secret impd holds: `custom`, the default, `oauth`, or `github`.               |
| `env`          | Variables a `custom` profile sets in a session that reaches it. See below.                |
| `dependencies` | Profiles a session selecting this one needs beside it, such as a permission classifier's. |

A `github` profile gives a session HTTPS git and the GitHub API. It holds `secret`, `kind` and
`dependencies` only, so it takes no `env`, since impd's `github` kind sets the rules:
`Authorization: Basic` for `x-access-token` on `github.com`, and a bearer `authorization` header on
`api.github.com` and `uploads.github.com`. Add the secret with
`impz secret add <secret> --kind github`, list it in the `--grantable` secrets of the target's impd
token when you make the token, and select the profile beside the model's:

```json
{
  "authProfiles": {
    "github": { "secret": "github-imp-agents", "kind": "github" }
  },
  "agents": {
    "glm": {
      "kind": "claude",
      "baseURL": "https://api.z.ai/api/anthropic",
      "auth": { "profiles": ["glm", "github"] }
    }
  }
}
```

impd sets `GH_TOKEN` and `GITHUB_TOKEN` to `imp-broker-placeholder` in the session, so `gh` and
`git` run with no sign-in, and the token stays on the host. If impd changes the hosts of its
`github` kind, a launch fails with `auth_secret_mismatch` until atc's rules match again.

## Profile variables

A `custom` profile's `env` sets variables in the guest of each session that reaches the profile,
through the entry's `auth.profiles` or a dependency. The local target never gets them. This gives a
tool in the guest the endpoint of a service the broker authenticates, such as 1Password Connect. Add
the secret with its value on stdin:

```sh
impz secret add op-connect --kind custom --hosts op-connect.geoff.cloud --header authorization --scheme bearer
```

Then add a profile that sets the variables, and select it in an agent's `auth.profiles`:

```json
{
  "authProfiles": {
    "op-connect": {
      "secret": "op-connect",
      "host": "op-connect.geoff.cloud",
      "header": "authorization",
      "scheme": "bearer",
      "env": {
        "OP_CONNECT_HOST": "https://op-connect.geoff.cloud",
        "OP_CONNECT_TOKEN": "imp-broker-placeholder"
      }
    }
  },
  "agents": {
    "claude": { "auth": { "profiles": ["claude", "op-connect"] } }
  }
}
```

`op` sends the placeholder as the bearer token, and the broker swaps in the real token on requests
to that host. A value must be exactly `imp-broker-placeholder` or `https://` followed by the
profile's own `host`, with no path and no port, so a credential is never written into the config. A
name uses capital letters, digits and underscores, and starts with a letter or underscore. atc
leaves out a profile, and refuses an entry that selects it, when its `env` sets:

- A proxy or CA variable, any variable that overrides the subscription sign-in, `PATH`, or `HOME`.
- `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, or a name starting with `ANTHROPIC_`, `CLAUDE_`,
  `ATC_`, `CODEX_`, or `OPENAI_`.

Two selected profiles that set one variable to different values are refused, and so is an entry
whose `env` or `settings.env` sets a variable that one of its profiles sets. A change to a profile's
`env` gives the session's binding a new revision.
