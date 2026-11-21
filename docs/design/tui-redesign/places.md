# Places

- **Status:** draft

Each session descriptor, the session record that a daemon sends its clients, carries the session's
place: where its agent runs, either one remote service that several daemons can reach, such as an
imp service, or one daemon's target. The [session list](./session-list.md) and the
[fleet bar](./fleet-bar.md) group sessions by place. When two daemons each have a target that
reaches the same imp service, their sessions share one place and one group.

## Shape

```mermaid
flowchart LR
  cfg["target config: provider, options"] --> rule["provider's place(options)"]
  rule --> key[place key]
  label["target's label, else its id"] --> desc
  key --> desc["session descriptor: place, canDestroyHost"]
  desc --> tui[TUI groups by place.key]
```

## Contracts

```ts
const session = await client.procedures.session.get({ session: 'sess_8f2' });
// → { …existing fields,
//     place: { key: 'imp:place-v1:4be1c09a2d7e5f10', label: 'imp' },
//     canDestroyHost: true }
```

```ts
// @atcx/contract: SESSION_DESCRIPTOR_SCHEMA gains two optional fields
const SESSION_DESCRIPTOR_SCHEMA = z.object({
  // …existing fields
  place: z.object({ key: z.string(), label: z.string() }).optional(),
  canDestroyHost: z.boolean().optional(), // see The descriptor below
});
```

```ts
// @atc/plugin-api: an execution provider's PluginDefinition gains a place rule
interface PluginDefinition<K, C> {
  // …existing fields
  place?: (options: Readonly<Record<string, unknown>>) => PlaceParts;
}

type PlaceParts =
  | {
      scope: 'shared';
      version: string; // goes into the key; a provider changes it when it changes what parts hold, so old and new keys never match
      parts: Readonly<Record<string, unknown>>; // only the option values that name the remote service
    }
  | { scope: 'daemon' }; // the place belongs to this daemon and target only
```

```jsonc
// atc config file: a target gains an optional label
{
  "targets": {
    "impz": { "provider": "imp", "url": "https://imp.example.dev", "label": "imp" },
  },
}
```

| Provider    | `place(options)`                            |
| ----------- | ------------------------------------------- |
| `imp`       | shared, version `place-v1`, parts `{ url }` |
| `docker`    | daemon                                      |
| `sprites`   | daemon                                      |
| `local-pty` | daemon                                      |

## Constraints

### The key

- atc hashes `parts` as `buildTargetIdentity` hashes a target's options: the keys sorted at every
  depth, then JSON, then sha256. The sort compares code units, so two daemons with different locales
  still sort alike. A shared place key is `<provider>:<version>:<hash>`, where `<hash>` is the first
  16 hex characters.
- Before hashing, a provider writes each URL it puts in `parts` through `formatPlaceURL` in
  `@atc/plugin-api`, so `https://imp.example.dev/`, `https://IMP.example.dev:443` and
  `https://imp.example.dev./` give one key. `formatPlaceURL`:
  - lowercases the scheme and the host;
  - drops a default port, such as 443 for `https`;
  - drops a trailing dot from the host;
  - drops trailing slashes from the path, including a `/` just before `?` or `#`;
  - keeps the query, and drops an empty fragment.

  A string that does not parse as a URL with a `scheme://` keeps its own spelling, trimmed of
  spaces.

- Daemon scope means the place belongs to one daemon and one target, and never merges with a place
  on another daemon. Its key is `daemon:<daemonID>:<target id>`, where `daemonID` is the id that
  `atc daemon id` prints. atc percent-encodes the daemon id and the target id, so a colon in a
  target id becomes `%3A` and never reads as a separator. A sprites target has daemon scope though
  its machines run remotely.
- A provider with no `place` rule gets daemon scope.

### The target's label

- A target entry in the config is `provider`, an optional `label`, and the provider's options, which
  are every other key. atc takes `label` out of the entry before it passes the options to the
  provider, so `label` changes neither the target identity nor the place key.
- `place.label` is the target's `label` when the config sets one, else the target id.

### The descriptor

- The daemon fills `place` and `canDestroyHost` in every descriptor it sends: in the answers to
  `session.list`, `session.get` and `session.spawn`, and in each event that carries a descriptor.
- The gateway passes `place` and `canDestroyHost` through unchanged.
- The daemon sends `canDestroyHost` for the [session list](./session-list.md#end), which words its
  end prompt from it. It is true only when forgetting the session would delete its host, the machine
  or container the session runs on: this session's spawn created the host, and the check that
  `session.forget` runs allows the delete. It is false in these cases:
  - the session's provider has no hosts to delete, as for a local session;
  - another session's spawn created the host;
  - the provider cannot delete hosts (its `capabilities.destroy` is false);
  - `session.forget` refuses the session with `target_changed`: the session was saved under an
    earlier config of its target, or its saved binding to the target has no version and fleet
    restore could not confirm it.
- A session that `session.forget` refuses with `target_changed` gets the key
  `daemon:<daemonID>:<target id>:<saved target identity>`, so it never joins the place its target
  has now.

### In the TUI

- When a descriptor has no `place`, because its daemon was built before the field existed, the TUI
  uses key `daemon:<daemon name>:<target id>` and label `<target id>`, where `<daemon name>` is the
  daemon's name in the TUI's config, and `local` for the daemon on the TUI's own computer, which has
  no name there. Those sessions group by daemon and target. When that daemon upgrades, its places
  get daemon-scope or shared keys, and their colours can change.
- When the daemons in one place give it different labels, the TUI shows the label from the daemon on
  the TUI's own computer, else from the daemon listed first in the TUI config's `daemons`.
- When two different places have the same label, the TUI writes each as `<label> · <daemon name>`,
  with the name of the daemon whose label it shows, in group headers and in the fleet bar. When two
  of them still match, because one daemon serves both, the TUI adds the target id, and then the
  place key. It skips a part that repeats the label.
- The TUI picks a place's colour from its key, so a place has the same colour on every daemon that
  sends its key, and in every run.

## Decisions

- **Each provider names its place, as a function of its options.** Only the provider knows which
  options pick a remote service. Imp's `image` changes the machine, not the service.
- **docker targets have daemon scope.** A docker target takes only a socket path on the daemon's own
  machine, so no other daemon reaches its containers.
- **The place key is separate from the target identity.** The daemon uses a target identity to find
  a target's machines again, so it hashes every option that matters to that, including ones that
  differ between two daemons that reach one service, such as imp's `tokenFile`. A place key has to
  match across those daemons, so it hashes only what names the service.
- **sprites targets have daemon scope.** A sprites target's options name the API, not the account's
  org, so a key built from them would put every sprites account in one place.
- **Two imp accounts on one imp service are one place.** Imp's parts hold only `url`, so the two
  accounts' sessions share one group under one label.

## Builder decides

- Where in the daemon `place` is computed, as long as every descriptor carries it.
- The palette that place colours come from.
