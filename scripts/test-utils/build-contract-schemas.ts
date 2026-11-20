import { z } from 'zod';
import type { ContractSchemas } from '../collect-contract-changes';

interface ContractSchemaOptions {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly event?: z.ZodType;
  readonly method?: string;
}

// Builds the schemas of a contract with one procedure, in the form the check reads.
export function buildContractSchemas(options: ContractSchemaOptions): ContractSchemas {
  return {
    procedures: {
      [options.method ?? 'session.spawn']: {
        input: z.toJSONSchema(options.input, { io: 'input', unrepresentable: 'any' }),
        output: z.toJSONSchema(options.output, { io: 'output', unrepresentable: 'any' }),
      },
    },
    event: z.toJSONSchema(options.event ?? z.object({}), { io: 'output', unrepresentable: 'any' }),
  };
}
