import { z } from 'zod';

export interface CollectedProcedure {
  readonly method: string;
  readonly meta: unknown;
  readonly inputKeys: readonly string[];
  readonly inputSchema: z.ZodType;
  readonly outputSchema: unknown;
}

// Every procedure of a contract, by its dotted method name.
export function collectContractProcedures(
  node: unknown,
  path: readonly string[] = [],
): CollectedProcedure[] {
  if (typeof node !== 'object' || node === null) {
    return [];
  }

  const def: unknown = Reflect.get(node, '~orpc');

  if (typeof def === 'object' && def !== null) {
    const inputSchema: unknown = Reflect.get(def, 'inputSchema');
    const outputSchema: unknown = Reflect.get(def, 'outputSchema');

    if (inputSchema instanceof z.ZodType && outputSchema !== undefined) {
      return [
        {
          method: path.join('.'),
          meta: Reflect.get(def, 'meta'),
          inputKeys: inputSchema instanceof z.ZodObject ? Object.keys(inputSchema.shape) : [],
          inputSchema,
          outputSchema,
        },
      ];
    }

    return [];
  }

  return Object.entries(node).flatMap(([key, child]) =>
    collectContractProcedures(child, [...path, key]),
  );
}
