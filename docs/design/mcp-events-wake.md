# Waking a hosted assistant with MCP Events

| Checked on | Protocol revision | atc build probed                 | MCP SDK in the lockfile                |
| ---------- | ----------------- | -------------------------------- | -------------------------------------- |
| 2026-10-22 | `2026-07-28`      | `atc/7.0.0`, `main` at `2a5b569` | `@modelcontextprotocol/server` `2.3.0` |

This spike asks whether a hosted assistant can subscribe to atc's MCP Events and be woken by one, so
that atc tells a subscribed assistant that something changed and the assistant reads the event trail
from its cursor instead of polling. It answers from the specification, each assistant's
documentation and public field reports, and from a local MCP client run against an atc daemon
started from a checkout.

The answer: one hosted assistant can be woken by MCP Events, and atc cannot be the server that wakes
it. ChatGPT subscribes to MCP Events by webhook in Work chats on the web, in Work chats in the
desktop app with Cloud selected, and in dots. Claude's hosted products call MCP tools only. atc
speaks protocol `2025-11-25`, answers neither `server/discover` nor any `events/*` method, and its
MCP SDK implements no part of Events, so no assistant can subscribe to atc until atc implements the
extension itself.

The recommendation is to build event delivery for ChatGPT in a later issue, and to start that issue
with the live check below on the smallest server that can pass it. Events is a draft extension
rather than part of the core specification, and ChatGPT reads a capability key that the draft has
since moved, so the build should follow the draft and the deployed client at once.

## What the specification says

The `2026-07-28` revision has no Events feature. Its
[changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) replaces
`resources/subscribe` and the HTTP GET stream with `subscriptions/listen`, a stream that lasts only
while the client holds the connection open, so it cannot wake an assistant that is not running.

Events is
[SEP-3415, the Events Extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415),
an open draft pull request. Its rules, read at head `2ec39b9`, are these:

- **Identity.** The extension is `io.modelcontextprotocol/events`, defined for `2026-07-28` and
  later. A server declares it under `capabilities.extensions` in its `server/discover` result. A
  prototype sketch that came before the SEP used a top-level `events` capability, and the SEP
  records that "at least one deployed client reads it".
- **Methods.** `events/list`, `events/subscribe` and `events/unsubscribe`, plus `events/poll`,
  `events/stream` and `notifications/events/list_changed`. "None is mandatory" among the poll, push
  and webhook delivery modes.
- **Secret.** The client supplies the signing secret in `delivery.secret`, a Standard Webhooks
  `whsec_` value, and the server never generates one. Each delivery is signed with
  `HMAC-SHA256(secret, webhook-id + "." + webhook-timestamp + "." + body)`.
- **Endpoint verification.** The server "MUST NOT begin delivering to a callback URL until the
  endpoint's intent to receive deliveries is confirmed". The usual way is a signed `verification`
  envelope whose challenge the endpoint echoes in a 2xx body.
- **Payload.** Each delivery is one `{eventId, name, timestamp, data, cursor}` object, with the
  Standard Webhooks headers and `X-MCP-Subscription-Id`. The cursor is a watermark, so out-of-order
  delivery never makes a client save an unsafe cursor.
- **Retries.** The server retries a non-2xx delivery with exponential backoff, capped at about 3 to
  5 attempts over no more than 10 to 15 minutes.
- **410.** "The server MUST treat `410` as a non-retryable failure for that delivery (like `413` …),
  without affecting the subscription itself."
- **Lifetime.** A subscription expires at the `refreshBefore` the server grants, and the client
  calls `events/subscribe` again before then. `ttlMs: null` asks for no expiry.

How a host wakes its model when an event arrives is left to the application.

## What each assistant supports

| Assistant                                       | Subscribes to MCP Events | Source                                                                                                                             |
| ----------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT Work chats (web, desktop with Cloud)    | yes, webhook only        | [OpenAI MCP Events guide](https://developers.openai.com/plugins/build/mcp-events)                                                  |
| ChatGPT dots                                    | yes, webhook only        | the same guide                                                                                                                     |
| ChatGPT ordinary chats, OpenAI Responses API    | not documented           | [Responses API MCP guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) lists tool import only               |
| Claude.ai custom connectors, Desktop and mobile | no                       | [custom connectors guide](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp) |
| Claude API MCP connector                        | no                       | [MCP connector docs](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)                                           |

### ChatGPT

OpenAI's guide says that "MCP Events lets ChatGPT subscribe to updates from your MCP server" and
that it needs MCP 2.0, which is protocol `2026-07-28`. The server adds `events` to the capabilities
in its `server/discover` result and serves `events/list`, `events/subscribe` and
`events/unsubscribe` "on the same authenticated endpoint as your tools". "Polling, streaming, and
the draft's `gap` and `terminated` control notifications are not supported." ChatGPT verifies the
callback with the signed challenge, refreshes before `refreshBefore` with its last cursor, and tells
the server: "Do not retry deliveries that return `410` or `413`." A delivery body holds one event
and stays under 256 KiB. When an event arrives, "ChatGPT receives the event in the subscribed chat
and follows the user's instructions for how to respond."

The field reports in [openai/codex#49665](https://github.com/openai/codex/issues/49665) agree with
the guide once a connector is set up, and they show three ways a setup fails first. No OpenAI staff
member has answered in the thread.

1. The original report found no subscribe action in a Chat or a Work conversation, with the reply
   that the chat "exposes no native MCP event subscription action or callable events/subscribe
   method".
2. One reporter's `events/subscribe` returned `insufficient_scope` while read tools worked, until a
   tool declared that it requests the event scope. In that report, ChatGPT asked only for the OAuth
   scopes that the server's tools declared.
3. A dot woke on a delivery but did not see the event's `data`, and the same server's Work chat on
   the web did. The dot's trigger said that the data comes in an `automations.mcp_event` tool result
   that the run never held.

In each case a later **Refresh tools** on the plugin page made ChatGPT discover the event, and
reporters then saw a Work chat and a dot subscribe through `connectors.api.openai.com`, pass
verification, and act on the payload within seconds.

### Claude

The MCP connector docs say: "Of the feature set of the MCP specification, only tool calls are
currently supported." The custom connectors guide describes tools only, and names no event,
subscription or server-started wake. An open request,
[anthropics/claude-code#101434](https://github.com/anthropics/claude-code/issues/101434), asks for
SEP-3415 support in Claude.ai connectors and has no reply from Anthropic. Claude Code's
[channels](https://code.claude.com/docs/en/channels) push messages into a running CLI session, which
is a different mechanism from MCP Events and reaches no hosted Claude product.

### Other assistants

The official [extension support matrix](https://modelcontextprotocol.io/extensions/client-matrix)
has no Events column. No documentation for Gemini, Microsoft 365 Copilot, Le Chat, Perplexity or
Cursor mentions MCP Events, so treat each as unsupported until its documentation says otherwise.

## What atc answers

A local client drove `atc mcp` over stdio against a daemon in a scratch home, and asked for
`2026-07-28` with the events capability in both the SEP form and the ChatGPT form. Times are
milliseconds since the client started, the subscribe callback is a made-up address, and `[...]`
marks the cut text content of the last reply:

```text
    37 -> {"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"extensions":{"io.modelcontextprotocol/events":{}}},"io.modelcontextprotocol/clientInfo":{"name":"events-spike-probe","version":"0.0.1"}}}}
  1130 <- {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}
  1131 -> {"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{"events":{}},"clientInfo":{"name":"events-spike-probe","version":"0.0.1"}}}
  1162 <- {"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"atc","version":"atc/7.0.0+mvj58frf"}},"jsonrpc":"2.0","id":2}
  1162 -> {"jsonrpc":"2.0","method":"notifications/initialized"}
  1162 -> {"jsonrpc":"2.0","id":3,"method":"events/list","params":{}}
  1166 <- {"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"Method not found"}}
  1166 -> {"jsonrpc":"2.0","id":4,"method":"events/subscribe","params":{"name":"session.attention","delivery":{"mode":"webhook","url":"https://assistant.example.test/mcp-events/hook-7f3a"}}}
  1170 <- {"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"Method not found"}}
  1170 -> {"jsonrpc":"2.0","id":5,"method":"events/unsubscribe","params":{"subscriptionId":"sub-probe-1"}}
  1171 <- {"jsonrpc":"2.0","id":5,"error":{"code":-32601,"message":"Method not found"}}
  1171 -> {"jsonrpc":"2.0","id":6,"method":"resources/subscribe","params":{"uri":"atc://events"}}
  1173 <- {"jsonrpc":"2.0","id":6,"error":{"code":-32601,"message":"Method not found"}}
  1173 -> {"jsonrpc":"2.0","id":7,"method":"subscriptions/listen","params":{}}
  1175 <- {"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"Method not found"}}
  1175 -> {"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"atc_events_read","arguments":{}}}
  1407 <- {"result":{"content":[...],"structuredContent":{"events":[],"cursor":"WyJldmVudHMiLDBd","more":false}},"jsonrpc":"2.0","id":8}
```

atc downgrades the client to `2025-11-25`, declares only `tools`, and refuses every discovery and
subscription method. The cursor that `atc_events_read` returns is the one a wake would point the
assistant at. The HTTP endpoint that a hosted assistant reaches builds the same MCP server for each
request, so it answers alike once a client holds a grant. Before a grant it refuses every method:

```text
POST http://127.0.0.1:40317/mcp  {"jsonrpc":"2.0","id":1,"method":"events/list","params":{}}
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer resource_metadata="http://127.0.0.1:40317/.well-known/oauth-protected-resource/mcp"
```

The cause sits in the SDK. `@modelcontextprotocol/server` `2.3.0` lists `2025-11-25` as its newest
protocol version and holds no `events/` method, and `2.3.1`, the newest release, holds none either.
The SDK repository tracks an experimental Events module in
[typescript-sdk#2945](https://github.com/modelcontextprotocol/typescript-sdk/issues/2945), and
SEP-3415 lists its reference implementation as outstanding.

## What full delivery needs

The plan for full delivery holds, with three changes that the draft and ChatGPT's guide require:

- **Protocol.** atc answers `server/discover` and negotiates `2026-07-28`, either through an SDK
  release that does or through a handler in front of the SDK.
- **Capability.** atc declares both the SEP's `extensions["io.modelcontextprotocol/events"]` entry
  and ChatGPT's top-level `events` key, until ChatGPT reads the SEP form.
- **Verification.** atc sends the signed `verification` challenge before it delivers to a callback,
  and keeps the verified status beside each persisted subscription. The callback must be https, must
  not redirect, and must not resolve to a private address.

The plan's 410 rule is an open question for the build. The plan drops a subscription on a 410. The
draft ends retries for that one delivery and keeps the subscription, which then ends at its
`refreshBefore` or when the client unsubscribes. ChatGPT's guide says only that a 410 is not
retried, so either rule works with ChatGPT.

The payload carries the event name, the atc session id in `data`, and the event trail's cursor in
`cursor`, beside the `eventId` and `timestamp` the draft requires. That cursor points past its
event, because a trail read returns only the events after the cursor it gets, which matches the
draft's watermark. The assistant therefore treats a delivery as a wake only: it reads the trail from
the cursor its previous read returned, and keeps the cursor that the new read returns. A lost
delivery costs nothing, because the next wake's read returns the missed event. A repeated delivery
repeats nothing, because the assistant drops a seen `eventId` and its read returns no event twice.
Subscribing needs the `read` grant scope. atc's tools declare no per-tool security scheme, so the
live check shows whether ChatGPT asks for `read` from the server's metadata alone or needs a tool to
declare it.

## The live check

The check needs an atc build that serves the three changes above, a public https origin for its
`/mcp`, and a ChatGPT plan whose workspace allows plugins and event-triggered tasks. Run it on that
build in a home of its own:

1. Start the daemon and the HTTP server, with a tunnel such as `cloudflared` in front of the
   server's port:

   ```bash
   atc daemon &
   atc mcp --http --public-url https://<public_host>
   ```

2. Add ChatGPT as a client and enroll a passkey, as the [remote MCP guide](../guides/remote-mcp.md)
   describes:

   ```bash
   atc clients add ChatGPT --redirect-uri https://chatgpt.com/connector_platform_oauth_redirect
   atc passkeys enroll
   ```

3. In ChatGPT, add a plugin with the URL `https://<public_host>/mcp` and the client ID, sign in with
   the passkey, and grant `read`.
4. Select **Refresh tools** on the plugin page. Expect the atc event types next to the tools.
5. In a Work chat on the web, ask: "Read my atc event feed once, then watch my atc sessions, and
   when one needs me, tell me which one and why." Expect an `atc_events_read` call, then an
   `events/subscribe` request in the server's log, then a `verification` POST to
   `connectors.api.openai.com` that returns 2xx.
6. Spawn a session on that build and leave it at a permission prompt. Expect a signed delivery that
   returns 2xx within seconds, then a ChatGPT message that names the session id.
7. Ask the chat what changed since its last read. Expect an `atc_events_read` call that passes the
   cursor from the read in step 5 and returns the permission prompt's event.
8. Repeat steps 5 to 7 in a dot. A dot that wakes without the event's data finds the event in its
   step 7 read, because that read starts from the cursor of its step 5 read.

Keep the server log of steps 5 to 7, and ChatGPT's replies, as the evidence. Step 6 fails safe: a
missed delivery shows as an event the chat finds only in step 7.
