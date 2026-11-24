import { expect, test } from 'bun:test';
import { oc } from '@orpc/contract';
import { z } from 'zod';
import { collectContractProcedures } from './collect-contract-procedures';

test('#collectContractProcedures names a nested procedure by its dotted path', () => {
  const contract = {
    session: {
      scope: {
        add: oc.input(z.object({ session: z.string() })).output(z.object({})),
      },
    },
  };

  const [procedure] = collectContractProcedures(contract);

  expect([procedure?.method, procedure?.inputKeys]).toStrictEqual([
    'session.scope.add',
    ['session'],
  ]);
});
