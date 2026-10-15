# Codex subscription on imps

`auth` on a Codex entry signs it in on an imp target with the ChatGPT sign-in that impd holds as an
[oauth secret](https://github.com/zgeoff/impz/blob/main/docs/guides/connectors.md#oauth-secrets).
impd renews the access token from the refresh token and sets it on each request to `chatgpt.com`, so
no token enters the imp. On the local target, Codex keeps the sign-in of your own Codex config. An
imp target needs impd with oauth secrets; an older impd refuses the spawn with `auth_impd_too_old`.
The [brokered credentials guide](./brokered-credentials.md) covers the profiles `auth` selects.

1. Sign Codex in with your ChatGPT account on your machine, so `~/.codex/auth.json` holds a refresh
   token.
2. Add that refresh token to impd as an `oauth` secret on `chatgpt.com`, with the value on stdin:

   ```bash
   jq -r .tokens.refresh_token ~/.codex/auth.json | impz secret add codex-chatgpt --kind oauth \
     --hosts chatgpt.com --token-url https://auth.openai.com/oauth/token \
     --client-id app_EMoamEEZ73f0CkXaXp7hrann --token-format json
   ```

   impd rotates the refresh token on its first refresh, so the sign-in in `~/.codex/auth.json` stops
   working. Sign in again on your machine if you still need Codex there.

3. List the secret in the `--grantable` secrets of the target's impd token.
4. Add an `oauth` profile for the secret and select it in the entry's `auth`, beside any other
   profile the session needs:

   ```json
   {
     "authProfiles": {
       "codex": {
         "secret": "codex-chatgpt",
         "kind": "oauth",
         "host": "chatgpt.com",
         "header": "authorization",
         "scheme": "bearer"
       },
       "github": { "secret": "github-imp-agents", "kind": "github" }
     },
     "agents": { "codex": { "auth": { "profiles": ["codex", "github"] } } }
   }
   ```

A Codex entry's `auth` holds `profiles` alone. atc leaves the entry out and prints the reason when
the daemon starts if a selected profile does not resolve, or if no `oauth` profile sets a bearer
`authorization` header for `chatgpt.com`.

On an imp target, each session gets a Codex home of its own, `codex-home` in its guest folder,
passed as `CODEX_HOME`. Before each launch, atc copies three files into it:

- `auth.json`, a ChatGPT sign-in that holds no credential. Its access and refresh tokens are
  `imp-broker-placeholder`, and its ID token is an unsigned copy of the email and the
  `https://api.openai.com/auth` claims that impd lists for the secret. Codex sends the account id
  from those claims with each request, so it must be the real one.
- `config.toml`, which keeps the sign-in in that file and turns off the update check. With
  [clone trust](./targets.md#clone-trust), it also trusts the clone root.
- `hooks.json`, the hook entries `atc codex-hooks` prints, run through the atc inside the imp.

Codex starts with `--dangerously-bypass-hook-trust`, the Codex flag for automation that writes its
own hooks, since no person is there to approve them in the Codex TUI. The flag runs every hook Codex
loads, so with clone trust the hooks in the repository's own `.codex` folder run without review too.
`OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` are unset in the launch, since each
would sign Codex in another way. Codex records its sessions in the same folder, so a resume finds
them. Each launch replaces `config.toml`, so a folder trust a person accepts in the Codex TUI lasts
until the session restarts.

A spawn, resume, or adopt fails with `auth_signin_needed` before the imp is touched when impd lists
the secret as `pending` or `needs_login`, or when its ID token holds no ChatGPT account id. impd
marks the secret `needs_login` when the token endpoint refuses the refresh token. To renew the
sign-in, sign Codex in again on your machine and replace the secret with
`impz secret add codex-chatgpt --kind oauth ... --replace`, fed with the new refresh token.

A Claude entry signs in the Codex CLI it runs as a tool, such as `codex review`, when its `auth`
selects the same `oauth` profile beside its own:

```json
{ "agents": { "claude": { "auth": { "profiles": ["claude", "codex", "github"] } } } }
```

On an imp target, each launch of such a session writes a Codex home into the folder of its auth
binding's revision, `auth-r<revision>/codex-home`, and passes it as `CODEX_HOME`. The home holds the
`auth.json` that a Codex session gets and the same `config.toml` without clone trust. It holds no
hook file, since the Codex run belongs to the Claude session. Because `CODEX_HOME` moves Codex to
that home, none of the host image's own Codex settings apply, such as its model or MCP servers. The
launch unsets `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN`, since each would sign
Codex in another way. A variable that the entry's `env` sets reaches the session after that, so
leave those three out of it. A sign-in that impd lists as `pending` or `needs_login`, or one whose
ID token holds no ChatGPT account id, does not stop the Claude session: atc writes no Codex home,
and Codex keeps the sign-in and settings of the host's image.
