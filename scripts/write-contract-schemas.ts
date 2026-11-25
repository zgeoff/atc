import { z } from 'zod';

// The contract's procedures that a release may lack, with the prefix each is recorded under.
const OPTIONAL_CONTRACTS = [
  ['FLEET_CONTRACT', 'fleet:'],
  ['LOCAL_FLEET_CONTRACT', 'fleet-local:'],
] as const;

interface ContractSchemas {
  readonly procedures: Readonly<Record<string, { input: unknown; output: unknown }>>;
  readonly event: unknown;
}

// Collects the JSON Schema of each procedure's input and answer and of the event. The check runs
// it on the current source and on the source at the latest release tag. A release with no fleet
// contract records none, so the check compares nothing for it.
export function collectContractSchemas(contract: unknown): ContractSchemas {
  const procedures: Record<string, { input: unknown; output: unknown }> = {};

  collectSchemas(getExport(contract, 'DAEMON_CONTRACT'), '', procedures);

  for (const [name, prefix] of OPTIONAL_CONTRACTS) {
    if (hasExport(contract, name)) {
      collectSchemas(getExport(contract, name), prefix, procedures);
    }
  }

  const event = toJSONSchema(getExport(contract, 'DAEMON_EVENT_SCHEMA'), 'output');

  return { procedures, event };
}

export function writeContractSchemas(contract: unknown): void {
  process.stdout.write(JSON.stringify(collectContractSchemas(contract)));
}

function collectSchemas(
  node: unknown,
  prefix: string,
  procedures: Record<string, { input: unknown; output: unknown }>,
): void {
  for (const [method, procedure] of collectProcedures(node, [])) {
    procedures[`${prefix}${method}`] = {
      input: toJSONSchema(procedure.inputSchema, 'input'),
      output: toJSONSchema(procedure.outputSchema, 'output'),
    };
  }
}

function hasExport(module: unknown, name: string): boolean {
  return typeof module === 'object' && module !== null && name in module;
}

interface ProcedureSchemas {
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
}

function collectProcedures(node: unknown, path: readonly string[]): [string, ProcedureSchemas][] {
  if (typeof node !== 'object' || node === null) {
    return [];
  }

  const procedure: unknown = Reflect.get(node, '~orpc');

  if (typeof procedure === 'object' && procedure !== null) {
    return [
      [
        path.join('.'),
        {
          inputSchema: Reflect.get(procedure, 'inputSchema'),
          outputSchema: Reflect.get(procedure, 'outputSchema'),
        },
      ],
    ];
  }

  return Object.entries(node).flatMap(([key, child]) => collectProcedures(child, [...path, key]));
}

function getExport(module: unknown, name: string): unknown {
  if (typeof module !== 'object' || module === null || !(name in module)) {
    throw new Error(`the contract exports no ${name}`);
  }

  return Reflect.get(module, name);
}

function toJSONSchema(schema: unknown, io: 'input' | 'output'): unknown {
  if (!(schema instanceof z.ZodType)) {
    return null;
  }

  return z.toJSONSchema(schema, { io, unrepresentable: 'any' });
}
