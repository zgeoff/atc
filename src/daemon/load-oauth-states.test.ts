import { expect, test } from 'bun:test';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { collectAuthProfiles } from '../shared/collect-auth-profiles';
import type { BrokerAuthHost } from './broker-auth-host';
import { buildAuthBinding } from './build-auth-binding';
import type { AuthBinding } from './build-auth-binding';
import { loadOAuthStates } from './load-oauth-states';

const CHATGPT_RULE = { host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' } as const;

const PROFILES = collectAuthProfiles({
  codex: { secret: 'codex-chatgpt', kind: 'oauth', ...CHATGPT_RULE },
  glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
}).profiles;

const READY = {
  status: 'ready',
  idClaims: { email: 'someone@example.com' },
} as const;

// A broker host over a fixture imp port, which reaches impd's features
// and secrets alone.
function setupHost(port: BrokerAuthHost['port']): BrokerAuthHost {
  return {
    impPrefix: 'atc-',
    port,
    getImpName: (hostKey) => `atc-${hostKey}`,
    createImp: () => Promise.reject(new Error('not reached')),
    destroyImp: () => Promise.reject(new Error('not reached')),
  };
}

function buildBinding(profiles: readonly string[]): AuthBinding {
  const planned = buildAuthBinding(
    {
      id: 'codex',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      auth: { profiles, placeholderEnv: {} },
    },
    PROFILES,
  );

  if ('problem' in planned) {
    throw new Error(planned.problem.message);
  }

  return planned.binding;
}

test('it reads nothing from impd for a binding without an oauth secret', async () => {
  using port = new FixtureImpPort();

  const states = await loadOAuthStates(setupHost(port), buildBinding(['glm']));

  expect({ states, calls: port.calls }).toStrictEqual({ states: undefined, calls: [] });
});

test("it reads each bound oauth secret's sign-in state from impd's features and one secret list", async () => {
  using port = new FixtureImpPort();

  port.createSecret('codex-chatgpt', 'oauth', [CHATGPT_RULE], READY);

  port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const states = await loadOAuthStates(setupHost(port), buildBinding(['codex', 'glm']));

  expect({ states, calls: port.calls }).toStrictEqual({
    states: { 'codex-chatgpt': READY },
    calls: ['system.info', 'secrets.list'],
  });
});

test('it refuses an impd without oauth secrets before it lists any secret', async () => {
  using port = new FixtureImpPort();

  port.features = { ...port.features, oauthSecrets: false };

  const refusal: unknown = await loadOAuthStates(setupHost(port), buildBinding(['codex'])).catch(
    (error: unknown) => error,
  );

  expect({ refusal, calls: port.calls }).toMatchObject({
    refusal: {
      code: 'auth_impd_too_old',
      message: 'impd lacks oauth secret support, which codex-chatgpt needs',
    },
    calls: ['system.info'],
  });
});

test.each([
  ['missing', null],
  ['held as another kind', 'custom'],
] as const)('it refuses a bound oauth secret that impd lists as %s', async (_name, kind) => {
  using port = new FixtureImpPort();

  if (kind !== null) {
    port.createSecret('codex-chatgpt', kind, [CHATGPT_RULE]);
  }

  const refusal: unknown = await loadOAuthStates(setupHost(port), buildBinding(['codex'])).catch(
    (error: unknown) => error,
  );

  expect(refusal).toMatchObject({ code: 'auth_secret_mismatch' });
});

test('it turns a call impd fails into an unavailable host', async () => {
  using port = new FixtureImpPort();

  port.setFeatureFailures(1);

  const refusal: unknown = await loadOAuthStates(setupHost(port), buildBinding(['codex'])).catch(
    (error: unknown) => error,
  );

  expect(refusal).toMatchObject({
    code: 'host_unavailable',
    data: { provider: 'imp', problem: 'unreachable' },
  });
});
