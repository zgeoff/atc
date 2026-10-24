# MCP Events

`atc mcp --http` lets a hosted assistant subscribe to the fleet's events by webhook, under the draft
MCP Events extension, so that atc wakes the assistant when a session finishes a turn, ends, sends a
note or waits on its owner. A delivery is only a wake: it carries the event's name, its session and
a cursor, and the assistant reads what happened from the event trail with `atc_events_read`. The
server stores each subscription in the authorization server's database and delivers from the trail,
so a restart of the server or of the daemon loses no event the trail still holds. Events is a draft
that ChatGPT implemented ahead of its final form, so where the draft and ChatGPT differ, atc serves
both.

[The MCP servers](./mcp.md) cover the tools and grant scopes, and
[the event trail](../protocol/events.md#the-event-trail) covers the cursors a delivery points into.

## Two protocol revisions

The HTTP server serves each request in the protocol revision the request is written in. A request
that carries its protocol version in `_meta` belongs to the stateless `2026-07-28` revision, and the
MCP SDK's stateless handler serves it: `server/discover`, the tools and the event methods. A request
without that field belongs to the `2025-11-25` revision, and the server serves it the way it serves
every earlier client. Events is defined only for the stateless revision, so a client that subscribes
first calls `server/discover`.

The discovery answer declares Events twice: under the draft's `io.modelcontextprotocol/events` entry
in `extensions`, and under a top-level `events` key, which ChatGPT reads from the sketch that came
before the draft.

## Event types

Each event type fires on one kind of trail event, and takes no arguments:

| Event type            | Fires on                               |
| --------------------- | -------------------------------------- |
| `session.needs_input` | a session's agent waiting on the owner |
| `session.turn_done`   | a session's agent finishing a turn     |
| `session.ended`       | a session ending                       |
| `session.note`        | a note a session sends                 |

`events/list` returns them with webhook as the only delivery mode, an input schema that takes no
property, and a payload schema that holds the session id.

## Subscribing

A client subscribes with `events/subscribe`, naming the event type, an https callback URL, a
Standard Webhooks `whsec_` secret it generated, the cursor it last saved and the lifetime it
suggests. Every event method needs the `read` scope, because a delivery reveals that a session the
client reaches did something. A token without it gets HTTP 403 with `insufficient_scope`, as a tool
call outside its scopes does.

The client, the callback URL, the event type and its arguments make the subscription's key, and the
server derives the subscription id from the key. A second subscribe with the same key is a refresh:
it replaces the secret and grants a new lifetime, and delivery carries on from where it got to,
whatever cursor the refresh sends. The id grants nothing, so the server logs it and puts it in a
header on every delivery. On `events/unsubscribe` with the same key, the server ends the
subscription the key derives and returns the same empty result whether a subscription existed or
not, so a client can repeat it.

Before the server stores a subscription, it posts a signed verification envelope with a one-time
challenge to the callback URL, and stores the subscription only if the endpoint echoes the challenge
in a 2xx answer. The check stops a client from aiming atc's deliveries at an endpoint that never
asked for them. One echo covers that client's subscriptions to that URL for a while, so a refresh or
a second event type posts no new challenge, and another client's subscribe to the same URL posts its
own. A refused subscribe returns the error code ChatGPT's guide names for a callback that fails,
with a failure category and never the endpoint's answer, so atc cannot be used to read another
server's replies.

A new subscription starts after the cursor the client sent, once the daemon accepts that cursor, so
the events the client missed while it held no subscription are delivered. With no cursor, it starts
after the newest event of every daemon the server reads through. The server always grants a finite
lifetime, and grants its longest one to a client that asks for no expiry, so a client that stops
refreshing loses its subscription in the end. A subscribe that arrives after the lifetime ran out
starts a new subscription from the cursor it sends.

A subscription ends with the client's access. When the owner revokes the client's last live grant
that holds `read`, or removes the client, the server deletes the client's subscriptions and its
verified callback URLs in the same transaction, so no delivery outlives the access it reports on.
The client's own token revocation and a grant's expiry leave the rows in place, so the watcher
checks for a live grant with `read` before each read and each delivery. When it finds none, it
delivers nothing, and removes the subscription only if a second check after a short wait finds none
either, because the authorization server rotates a refresh token in two writes, and a check between
them finds no live grant.

## Delivery

Each subscription has a watcher in the server that reads the trail as the subscription's client, the
way the client's own `atc_events_read` call reads it, so the watcher sees only the sessions the
client's principal reaches ([principals](../protocol/principals.md)). The watcher holds its read
open until an event arrives, and stores the cursor past each event once it has dealt with it, so a
restarted server resumes from the first event it had not reached. When the trail refuses the stored
cursor, as after a daemon behind a gateway starts a new incarnation, the watcher removes the
subscription, so the client's next subscribe starts a new one from the cursor it sends.

For each event of its type, the watcher posts one signed JSON body: the event id, the type, the time
the event happened, the session id in `data`, and the cursor past the event. The headers follow the
Standard Webhooks profile the draft defines: a `webhook-id`, the signing time, an HMAC-SHA256
signature over the id, the time and the exact body bytes, and the subscription id. The event id
derives from the event's place in the trail the server reads, and the `webhook-id` from the
subscription and that place, so a retry, or a delivery again after a restart, carries the same ids.
On one daemon, that place is the event's cursor. Behind a gateway, the merged cursor changes when
another daemon's place moves, so the server takes the place from the `origin` the gateway puts on
each merged event: its daemon, that daemon's incarnation and that daemon's cursor. The event id is
unique only among the events one server delivers, because the daemons behind two servers can each
hold an event at the same place.

The server posts only to a callback whose host resolves to public addresses, and connects to the
address it checked, with the URL's host name for TLS, so a DNS answer that changes between the check
and the connection cannot point a delivery at a private network. It follows no redirect.

The watcher retries a delivery that the endpoint refuses or does not answer, after a wait that grows
with each attempt, within the attempt count and the time the draft sets. Each retry reads the
subscription again and signs the same body afresh, with the subscription's current secret. Two
answers are final, as the draft makes them: a 410 Gone ends the subscription, and a 413 moves the
watcher on to the next event without a retry. When the last attempt fails, the watcher logs it and
moves on, and the subscriber finds the event on its next read of the trail. The watcher delivers one
event at a time, so a retry holds back the events after it.

## What a subscriber does

A subscriber treats a delivery as a wake. It reads the trail from the cursor its own last read
returned, keeps the cursor that read returns, and drops an event id it has seen from the same
subscription. A lost delivery then costs nothing while the next read falls inside the trail's
retention window, because that read returns the missed event, and a repeated delivery repeats no
work.
