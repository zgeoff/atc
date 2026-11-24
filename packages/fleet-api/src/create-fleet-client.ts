import { isRecord } from '@atc/core';
import { createRouterClient } from '@orpc/server';
import invariant from 'tiny-invariant';
import type { FleetClient, FleetContext, FleetRouter } from './types';

// One in-process client of a fleet router, acting as the context's principal with its scopes. An
// MCP tool call makes one, so each call is checked against the token that made it.
export function createFleetClient(router: FleetRouter, context: FleetContext): FleetClient {
  const client: unknown = createRouterClient(router, { context });

  invariant(isFleetClient(client), 'a fleet router holds every procedure of a fleet client');

  return client;
}

// The procedures of a fleet client by path. Only `daemons.list` is optional, because the local
// contract lacks it.
const REQUIRED_PATHS: readonly (readonly string[])[] = [
  ['agents', 'list'],
  ['dirs', 'list'],
  ['session', 'list'],
  ['session', 'get'],
  ['session', 'spawn'],
  ['session', 'update'],
  ['session', 'ack'],
  ['session', 'kill'],
  ['session', 'forget'],
  ['session', 'adopt'],
  ['session', 'submit'],
  ['session', 'screen'],
  ['session', 'menu'],
  ['session', 'choose'],
  ['session', 'read'],
  ['session', 'message'],
  ['session', 'scope', 'add'],
  ['session', 'auth', 'rebind'],
  ['message', 'get'],
  ['note', 'get'],
  ['answer', 'get'],
  ['events', 'read'],
];

function isFleetClient(client: unknown): client is FleetClient {
  return REQUIRED_PATHS.every((path) => {
    let node: unknown = client;

    for (const key of path) {
      node = isRecordLike(node) ? node[key] : undefined;
    }

    return typeof node === 'function';
  });
}

// An oRPC client is a function that answers property reads, so it is no plain record.
function isRecordLike(value: unknown): value is Readonly<Record<string, unknown>> {
  return isRecord(value) || typeof value === 'function';
}
