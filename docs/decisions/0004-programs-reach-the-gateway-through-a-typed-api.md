# 0004: Programs reach the gateway through a typed API

- Date: 2026-11-25
- Status: decided

## Decision

atc-gateway serves programs through a typed oRPC API at `/rpc`, beside its MCP tools at `/mcp`. One
fleet router, in `@atc/fleet-api`, runs every operation for both. The MCP tools call that router in
process and shape each answer for a model. Programs build against `FLEET_CONTRACT` in
`@atcx/contract` and connect through `@atcx/client/gateway`.

## Why

- Programs, such as nixie's coding adapter, call the gateway as service clients. Through MCP, a
  program picks `structuredContent` out of each tool result, polls `atc_events_read` with a cursor,
  and learns of a version mismatch only at runtime.
- The gateway owns what a program needs and a daemon lacks: ids that name the daemon, one merged
  event trail, and service tokens.
- The scope checks lived in the MCP layer. One router puts them on every front door.
- Every MCP tool calls the daemon through one untyped caller interface, so the router sits behind
  the tools in that interface's place, and the tools keep their shaping for a model.

## Rejected alternatives

- **MCP alone.** A program keeps reading tool output and polling. A version mismatch shows only at
  runtime.
- **`@atcx/client` against each daemon's TCP listener.** A program needs a listener token and a
  `principals` entry on each daemon, and loses the gateway's ids, its merged events and its service
  tokens.
- **A second API that calls the daemons beside the MCP tools.** Two implementations of each
  operation drift apart, and each needs its own scope checks.

## Consequences

- A change to a fleet procedure is a change to a published contract, and
  `bun run check:contract-compat` holds it to additive changes within a major version.
- A rule that belongs to an operation, such as a scope check or a guard on forget, goes in the
  router, never in one front door.
