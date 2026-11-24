import { expect, test } from 'bun:test';
import { LOCAL_FLEET_CONTRACT } from '@atcx/contract';
import { buildMockAgentList } from './build-mock-agent-list';

test('it builds an agent list that the local fleet contract accepts', async () => {
  const schema = LOCAL_FLEET_CONTRACT.agents.list['~orpc'].outputSchema;

  const parsed = await schema?.['~standard'].validate(
    buildMockAgentList([{ id: 'claude', installed: true }]),
  );

  expect(parsed).toMatchObject({ value: { agents: [{ id: 'claude', installed: true }] } });
});
