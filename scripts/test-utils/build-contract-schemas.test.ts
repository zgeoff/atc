import { expect, test } from 'bun:test';
import { z } from 'zod';
import { buildContractSchemas } from './build-contract-schemas';

test('it builds the schemas of one procedure and an empty event', () => {
  const schemas = buildContractSchemas({
    input: z.object({ cwd: z.string() }),
    output: z.object({ id: z.string() }),
  });

  expect(schemas).toStrictEqual({
    procedures: {
      'session.spawn': {
        input: expect.objectContaining({ properties: { cwd: { type: 'string' } } }),
        output: expect.objectContaining({ properties: { id: { type: 'string' } } }),
      },
    },
    event: expect.objectContaining({ type: 'object' }),
  });
});

test('it names the procedure it is given', () => {
  const schemas = buildContractSchemas({
    method: 'daemon.hello',
    input: z.object({}),
    output: z.object({}),
  });

  expect(Object.keys(schemas.procedures)).toStrictEqual(['daemon.hello']);
});
