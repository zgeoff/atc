import { isRecord } from '@atc/core';
import { FLEET_PROCEDURE_META_SCHEMA } from '@atcx/contract';
import type { FleetProcedureMeta, GrantScope } from '@atcx/contract';
import { ORPCError, os, traverseContractProcedures } from '@orpc/server';
import type { ContractRouter, Meta, Router } from '@orpc/server';
import invariant from 'tiny-invariant';
import { z } from 'zod';
import { buildCallerParams } from './build-caller-params';
import { buildLenientSchema } from './build-lenient-schema';
import { toFleetError } from './to-fleet-error';
import type { FleetCaller, FleetContext } from './types';

type FleetContractRouter = ContractRouter<Meta>;

interface FleetRouterOptions<TContract extends FleetContractRouter> {
  readonly caller: FleetCaller;
  readonly contract: TContract;
}

// One router for the gateway and for one daemon. It runs the operation rules for every front door
// and reaches the daemons only through the caller it is given.
export function createFleetRouter<TContract extends FleetContractRouter>(
  opts: FleetRouterOptions<TContract>,
): Router<TContract, FleetContext> {
  const tree: Record<string, unknown> = {};

  traverseContractProcedures({ router: opts.contract, path: [] }, (entry) => {
    const method = entry.path.join('.');
    const def = entry.contract['~orpc'];
    const meta = FLEET_PROCEDURE_META_SCHEMA.parse(def.meta);

    invariant(def.inputSchema !== undefined, `${method} declares no input`);
    invariant(def.outputSchema instanceof z.ZodType, `${method} declares no zod output`);

    const lenient = buildLenientSchema(def.outputSchema);

    const procedure = os
      .$context<FleetContext>()
      .use(async (options) => {
        refuseCaller(meta, options.context);

        try {
          return await options.next();
        } catch (error) {
          throw toFleetError(error);
        }
      })
      .input(def.inputSchema)
      .handler(async (call) => {
        const context = call.context;
        const params = isRecord(call.input) ? call.input : {};

        if (method === 'session.spawn') {
          refuseUngrantedAccess(params['atcAccess'], context.scopes);
        }

        const answer = await opts.caller.sendRequest(
          method,
          buildCallerParams(method, params),
          context.principal ?? undefined,
        );

        const checked = lenient.safeParse(answer);

        if (!checked.success) {
          throw new ORPCError('internal', {
            message: `the answer to ${method} does not match its contract: ${checked.error.issues[0]?.message ?? 'invalid'}`,
          });
        }

        return answer;
      });

    putProcedure(tree, entry.path, procedure);
  });

  // oxlint-disable-next-line typescript/consistent-type-assertions -- the tree holds one procedure per contract path, built from that contract's own paths, which TypeScript cannot follow through a traversal
  return tree as Router<TContract, FleetContext>;
}

function refuseCaller(meta: FleetProcedureMeta, context: FleetContext): void {
  if (!context.scopes.includes(meta.scope)) {
    throw new ORPCError('insufficient_scope', {
      message: `this token lacks the ${meta.scope} scope`,
      data: { required: [meta.scope] },
    });
  }

  if (meta.access === 'owner' && context.principal !== null) {
    throw new ORPCError('unauthorized', {
      message: 'only the daemon owner may call this procedure',
    });
  }
}

function refuseUngrantedAccess(requested: unknown, held: readonly GrantScope[]): void {
  const missing = Array.isArray(requested)
    ? requested.filter(
        (scope): scope is GrantScope =>
          typeof scope === 'string' && !held.some((scopeHeld) => scopeHeld === scope),
      )
    : [];

  if (missing.length > 0) {
    throw new ORPCError('insufficient_scope', {
      message: `atcAccess grants ${missing.join(', ')}, which this token does not hold`,
      data: { required: missing },
    });
  }
}

function putProcedure(
  tree: Record<string, unknown>,
  path: readonly string[],
  procedure: unknown,
): void {
  let node = tree;

  for (const key of path.slice(0, -1)) {
    const child = node[key];

    if (isRecord(child)) {
      node = child;
    } else {
      const created: Record<string, unknown> = {};

      node[key] = created;
      node = created;
    }
  }

  const last = path.at(-1);

  invariant(last !== undefined, 'a procedure has a path');

  node[last] = procedure;
}
