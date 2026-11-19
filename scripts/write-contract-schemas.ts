import { z } from 'zod';

// Writes the JSON Schema of each procedure's input and answer and of the event, for the contract
// module it is given. The check runs it on the current source and on the source at the latest
// release tag, so both sides go through one converter.
export function writeContractSchemas(contract: unknown): void {
  const procedures: Record<string, { input: unknown; output: unknown }> = {};

  for (const [method, procedure] of collectProcedures(
    readExport(contract, 'DAEMON_CONTRACT'),
    [],
  )) {
    procedures[method] = {
      input: toJSONSchema(procedure.inputSchema, 'input'),
      output: toJSONSchema(procedure.outputSchema, 'output'),
    };
  }

  const event = toJSONSchema(readExport(contract, 'DAEMON_EVENT_SCHEMA'), 'output');

  process.stdout.write(JSON.stringify({ procedures, event }));
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

function readExport(module: unknown, name: string): unknown {
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
