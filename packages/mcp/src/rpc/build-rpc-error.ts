import { CACHED_EFFECT_REF_MARK } from '@atc/core';
import { FLEET_ERROR_MAP } from '@atcx/contract';
import { ORPCError } from '@orpc/server';
import { findCodedError } from '../errors/find-coded-error';
import { unwrapUncodedError } from '../errors/unwrap-uncoded-error';

interface RPCErrorOptions {
  // `protocol_mismatch` alone carries the gateway's major version.
  readonly gatewayMajor?: number;
}

// An error of the router as a program reads it: the code, the message `/mcp` shows, and from the
// data the problem, the required scopes and the effect an `outcome_unknown` names. An effect the
// key binding restored from its cache is dropped, because the daemon checked its reach once.
export function buildRPCError(
  error: unknown,
  options: RPCErrorOptions = {},
): ORPCError<string, unknown> {
  const shown = unwrapUncodedError(error);
  const code = findCodedError(error)?.code ?? 'internal';
  const message = shown instanceof Error ? shown.message : String(shown);
  const data = findCodedError(error)?.data ?? {};

  return new ORPCError(code, {
    defined: Object.hasOwn(FLEET_ERROR_MAP, code),
    message,
    data: pickRPCErrorData(code, data, options),
  });
}

function pickRPCErrorData(
  code: string,
  data: Readonly<Record<string, unknown>>,
  options: RPCErrorOptions,
): Readonly<Record<string, unknown>> | undefined {
  const problem = data['problem'];
  const effectRef = data['effectRef'];
  const required = data['required'];
  const isCached = data[CACHED_EFFECT_REF_MARK] === true;

  const picked = {
    ...(typeof problem === 'string' ? { problem } : {}),
    ...(typeof effectRef === 'string' && !isCached ? { effectRef } : {}),
    ...(isStrings(required) ? { required } : {}),
    ...(code === 'protocol_mismatch' && options.gatewayMajor !== undefined
      ? { gatewayMajor: options.gatewayMajor }
      : {}),
  };

  return Object.keys(picked).length === 0 ? undefined : picked;
}

function isStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
