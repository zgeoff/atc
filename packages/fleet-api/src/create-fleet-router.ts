import { isRecord } from '@atc/core';
import { FLEET_ERROR_MAP, FLEET_PROCEDURE_META_SCHEMA } from '@atcx/contract';
import type { FleetProcedureMeta, GrantScope } from '@atcx/contract';
import { os, traverseContractProcedures } from '@orpc/server';
import type { ContractRouter, Meta, Router } from '@orpc/server';
import invariant from 'tiny-invariant';
import { z } from 'zod';
import { buildCallerParams } from './build-caller-params';
import { buildFleetError } from './build-fleet-error';
import { buildLenientSchema } from './build-lenient-schema';
import { isRouterOfContract } from './is-router-of-contract';
import { toFleetError } from './to-fleet-error';
import type { FleetCaller, FleetContext } from './types';

interface FleetRouterOptions<TContract extends ContractRouter<Meta>> {
  readonly caller: FleetCaller;
  readonly contract: TContract;
}

// One router for the gateway and for one daemon. It runs the operation rules for every front door
// and reaches the daemons only through the caller it is given. Each procedure keeps the contract's
// meta and error map, so a refusal reads as an error the procedure declares.
export function createFleetRouter<TContract extends ContractRouter<Meta>>(
  opts: FleetRouterOptions<TContract>,
): Router<TContract, FleetContext> {
  const tree: Record<string, unknown> = {};

  traverseContractProcedures({ router: opts.contract, path: [] }, (entry) => {
    const method = entry.path.join('.');
    const def = entry.contract['~orpc'];
    const meta = FLEET_PROCEDURE_META_SCHEMA.parse(def.meta);
    const inputSchema: unknown = def.inputSchema;
    const outputSchema: unknown = def.outputSchema;

    invariant(inputSchema instanceof z.ZodType, `${method} declares no zod input`);
    invariant(outputSchema instanceof z.ZodType, `${method} declares no zod output`);

    const lenient = buildLenientSchema(outputSchema);

    const procedure = os
      .$context<FleetContext>()
      .$meta<FleetProcedureMeta>(meta)
      .errors({ ...FLEET_ERROR_MAP, ...def.errorMap })
      .use((options) => {
        refuseCaller(meta, options.context);

        return options.next();
      })
      .handler(async (call) => {
        const context = call.context;

        const parsed = await inputSchema.safeParseAsync(call.input);

        if (!parsed.success) {
          throw buildFleetError('bad_args', {
            message: parsed.error.issues[0]?.message ?? 'invalid params',
            cause: parsed.error.issues,
          });
        }

        const params = isRecord(parsed.data) ? parsed.data : {};

        if (method === 'session.spawn') {
          refuseUngrantedAccess(params['atcAccess'], context.scopes);
        }

        const answer = await opts.caller
          .sendRequest(method, buildCallerParams(method, params), context.principal ?? undefined)
          .catch((error: unknown) => {
            throw toFleetError(error);
          });

        const checked = lenient.safeParse(answer);

        if (!checked.success) {
          throw buildFleetError('internal', {
            message: `the answer to ${method} does not match its contract: ${checked.error.issues[0]?.message ?? 'invalid'}`,
          });
        }

        return answer;
      });

    putProcedure(tree, entry.path, procedure);
  });

  invariant(isRouterOfContract(opts.contract, tree), 'the router holds every contract procedure');

  return tree;
}

function refuseCaller(meta: FleetProcedureMeta, context: FleetContext): void {
  if (!context.scopes.includes(meta.scope)) {
    throw buildFleetError('insufficient_scope', {
      message: `this token lacks the ${meta.scope} scope`,
      data: { required: [meta.scope] },
    });
  }

  if (meta.access === 'owner' && context.principal !== null) {
    throw buildFleetError('unauthorized', {
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
    throw buildFleetError('insufficient_scope', {
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
