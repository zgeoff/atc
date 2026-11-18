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
        "placeholderEnv": { "ANTHROPIC_AUTH_TOKEN": "broker-placeholder" }
      },
      "env": { "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-4.6" }
    }
  }
}
```

A variable that stands in for a credential holds `broker-placeholder`. impd sets the credential
header on each request it brokers, whatever the header held, so the placeholder only gets a tool
past its own check for a credential. atc reads `imp-broker-placeholder` as `broker-placeholder`, and
the daemon prints a deprecation warning when it starts with a config that holds that value.

Each profile in `authProfiles` holds a reference to a secret impd holds and the rule impd applies
with it:

| Key            | What it holds                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `secret`       | The name of the secret in impd, under impd's secret name rule.                                                         |
| `host`         | The exact host impd adds the credential for: lowercase, no port, no wildcard, no IP.                                   |
| `header`       | The lowercase header impd sets, such as `authorization`.                                                               |
| `scheme`       | How impd renders the value: `bearer`, or `raw` for the value alone. atc binds these two.                               |
| `kind`         | The kind of secret the profile names: `custom`, the default, `oauth`, or `github`.                                     |
| `env`          | Variables a `custom` profile sets in a session that reaches it. See [Profile variables](#profile-variables).           |
| `telemetry`    | `{ "logs": true }` sends the log records of a session's agents to `host`. See [Profile telemetry](#profile-telemetry). |
| `dependencies` | Profiles a session selecting this one needs beside it, such as a permission classifier's.                              |

An imp target is unusable while any profile's `secret` or `header` breaks impd's name rules, since
impd refuses that profile. The daemon prints the reason for each imp target when it starts.

A `github` profile gives a session HTTPS git and the GitHub API. It holds `secret`, `kind` and
`dependencies` only, so it takes no `env`, since impd's `github` kind sets the rules:
`Authorization: Basic` for `x-access-token` on `github.com`, and a bearer `authorization` header on
`api.github.com` and `uploads.github.com`. Add the secret to impd with the `github` kind, as impz's
[credential connectors guide](https://github.com/zgeoff/impz/blob/main/docs/guides/connectors.md#secrets-and-grants)
shows, list it in the `--grantable` secrets of the target's impd token when you make the token, and
select the profile beside the model's:

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
`git` run with no sign-in, and the token stays on the host. atc takes the hosts and headers of a
`github` secret from impd when a session launches. The launch fails with `auth_secret_mismatch` when
another selected profile sends its secret to one of those hosts.

impd 5 lists every secret kind but `oauth` as `static`, and atc accepts a `static` secret for a
`custom` or a `github` profile. For a `github` profile, the launch fails with `auth_secret_mismatch`
unless the `static` secret holds the rules of impd's `github` kind.

## Profile variables

A `custom` profile's `env` sets variables in the guest of each session that reaches the profile,
through the entry's `auth.profiles` or a dependency. The local target never gets them. This gives a
tool in the guest the endpoint of a service the broker authenticates, such as 1Password Connect. Add
the secret to impd as a `custom` secret on the Connect host, with a bearer `authorization` header.
Then add a profile that sets the variables, and select it in an agent's `auth.profiles`:

```json
{
  "authProfiles": {
    "op-connect": {
      "secret": "op-connect",
      "host": "op-connect.example.com",
      "header": "authorization",
      "scheme": "bearer",
      "env": {
        "OP_CONNECT_HOST": "https://op-connect.example.com",
        "OP_CONNECT_TOKEN": "broker-placeholder"
      }
    }
  },
  "agents": {
    "claude": { "auth": { "profiles": ["claude", "op-connect"] } }
  }
}
```

`op` sends the placeholder as the bearer token, and the broker swaps in the real token on requests
to that host. A value must be exactly `broker-placeholder` or `https://` followed by the profile's
own `host`, with no path and no port, so a credential is never written into the config. A name uses
capital letters, digits and underscores, and starts with a letter or underscore. atc leaves out a
profile, and refuses an entry that selects it, when its `env` sets:

- A proxy or CA variable, any variable that overrides the subscription sign-in, `PATH`, or `HOME`.
- `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, or a name starting with `ANTHROPIC_`, `CLAUDE_`,
  `ATC_`, `CODEX_`, or `OPENAI_`.

Two selected profiles that set one variable to different values are refused, and so is an entry
whose `env` or `settings.env` sets a variable that one of its profiles sets. A change to a profile's
`env` gives the session's binding a new revision.

## Profile telemetry

To send the OpenTelemetry log records of a session's agents to a service the broker authenticates,
set `telemetry` on the service's profile. Add the secret to impd as a `custom` secret on the
service's host. Then select the profile in an agent's `auth.profiles`:

```json
{
  "authProfiles": {
    "records": {
      "secret": "records",
      "host": "records.example.com",
      "header": "authorization",
      "scheme": "bearer",
      "telemetry": { "logs": true }
    }
  },
  "agents": {
    "claude": { "auth": { "profiles": ["claude", "records"] } }
  }
}
```

`telemetry` holds one key, `logs`, set to `true` or `false`. With `logs` set to `false`, or with no
`telemetry`, atc sets nothing. atc sends log records only, and no traces or metrics. atc builds each
endpoint from the profile's `host`, over `https`, so the config never holds an endpoint. A `github`
profile takes no `telemetry`, because it names no host. A session on the local target gets nothing
from `telemetry`.

On an imp target, atc sets up the agents of each session whose entry reaches the profile, through
its `auth.profiles` or a dependency:

- A Claude Code session gets four variables, in the settings file atc generates for the session and
  in the environment of the launch. This holds for an entry with a `baseURL` and for one without.
  The variables are `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`,
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, and
  `OTEL_EXPORTER_OTLP_ENDPOINT=https://records.example.com`. Claude Code adds `/v1/logs` to that
  endpoint.
- Codex gets no variable. Each Codex `config.toml` that atc writes for the session gets the log
  exporter below. Codex reads its exporter from that file alone, and ignores the four variables. The
  [Codex subscription guide](./codex-subscription.md) says when atc writes the file, for a Codex
  session and for the Codex CLI that a Claude Code session runs.

```toml
[otel]
log_user_prompt = false
exporter = { otlp-http = { endpoint = "https://records.example.com/v1/logs", protocol = "json" } }
```

The daemon starts without an agent entry that has one of these faults, and prints why at startup:

- Two of the profiles the entry reaches set `logs` to `true`.
- A profile the entry reaches sets `logs` to `true`, and the entry's `env`, `settings.env` or
  `auth.placeholderEnv` sets one of the four variables.
- One profile the entry reaches sets `logs` to `true`, and another sets one of the four variables in
  its `env`.
- A profile the entry selects sets `logs` to `true` and one of the four variables in its own `env`.
  The daemon drops that profile and prints why, so the entry has a profile that does not resolve.

Without `telemetry`, you can still set the four variables by hand: `OTEL_EXPORTER_OTLP_ENDPOINT` in
the profile's `env`, and the other three in the entry's `env`. Claude Code then sends its log
records, and Codex sends none, because atc writes no exporter into its `config.toml`.

A change to a profile's `telemetry` gives the session's binding a new revision, as a change to its
`env` does. atc also adds the session's id to every record, as
[Session telemetry](../../architecture/agents/agent-integration.md#session-telemetry) describes.
