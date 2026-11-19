import { expect, test } from 'bun:test';
import { buildMockAuthProfile } from '@atc/plugin-api/test-utils/build-mock-auth-profile';
import { buildStubCredentialRouter } from './build-stub-credential-router';

test('it routes each profile to a URL named for it and records each verification', async () => {
  const stub = buildStubCredentialRouter();
  const profiles = [buildMockAuthProfile({ name: 'claude' })];

  await stub.router.verifyRoutes(profiles);

  const routes = await stub.router.readRoutes(profiles);

  expect(routes).toStrictEqual({ claude: 'https://route.example/claude' });
  expect(stub.verified).toStrictEqual([['claude']]);
});
