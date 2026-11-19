import { expect, test } from 'bun:test';
import type { AuthSelection, CredentialRouter, HostCredentials } from '@atc/plugin-api';
import { buildStubCredentialBroker } from '../test-utils/build-stub-credential-broker';
import { decideHarnessAuth } from './decide-harness-auth';
import type { HarnessAuthDecision } from './decide-harness-auth';

type SelectionName = 'none' | 'optional' | 'required';

type CredentialsName = 'none' | 'broker' | 'routed' | 'stored-token';

type Outcome =
  | 'none'
  | 'broker'
  | 'routed'
  | 'stored-token'
  | 'broker_required'
  | 'guest_env_conflict'
  | 'route_required'
  | 'auth_on_stored_token'
  | 'sign_in_unsupported';

function setupTest() {
  const broker = buildStubCredentialBroker();

  const router: CredentialRouter = {
    hostPrefix: 'atc-',
    verifyRoutes: () => Promise.resolve(),
    readRoutes: () => Promise.resolve({}),
  };

  const selections: Readonly<Record<SelectionName, AuthSelection | null>> = {
    none: null,
    optional: {
      gateway: {
        id: 'claude',
        baseURL: 'https://api.anthropic.com',
        auth: { profiles: ['claude'], placeholderEnv: {} },
      },
      profiles: new Map(),
      brokerRequired: false,
    },
    required: {
      gateway: {
        id: 'claude',
        baseURL: 'https://api.anthropic.com',
        auth: { profiles: ['claude'], placeholderEnv: {} },
      },
      profiles: new Map(),
      brokerRequired: true,
    },
  };

  const credentials: Readonly<Record<CredentialsName, HostCredentials>> = {
    none: { kind: 'none' },
    broker: { kind: 'broker', broker, rebindChangedAuth: false },
    routed: { kind: 'routed', router },
    'stored-token': { kind: 'stored-token' },
  };

  const decisions: Readonly<Record<Outcome, HarnessAuthDecision>> = {
    none: { kind: 'none' },
    broker: { kind: 'broker', broker },
    routed: { kind: 'routed', router },
    'stored-token': { kind: 'stored-token' },
    broker_required: { kind: 'refused', problem: 'broker_required' },
    guest_env_conflict: { kind: 'refused', problem: 'guest_env_conflict' },
    route_required: { kind: 'refused', problem: 'route_required' },
    auth_on_stored_token: { kind: 'refused', problem: 'auth_on_stored_token' },
    sign_in_unsupported: { kind: 'refused', problem: 'sign_in_unsupported' },
  };

  return { selections, credentials, decisions };
}

interface DecisionRow {
  readonly selection: SelectionName;
  readonly credentials: CredentialsName;
  readonly conflict: string | null;
  readonly signInFile: string | null;
  readonly outcome: Outcome;
}

test.each<DecisionRow>([
  {
    selection: 'required',
    credentials: 'none',
    conflict: null,
    signInFile: null,
    outcome: 'broker_required',
  },
  {
    selection: 'required',
    credentials: 'broker',
    conflict: 'ANTHROPIC_BASE_URL',
    signInFile: null,
    outcome: 'guest_env_conflict',
  },
  {
    selection: 'required',
    credentials: 'routed',
    conflict: 'ANTHROPIC_API_KEY',
    signInFile: null,
    outcome: 'guest_env_conflict',
  },
  {
    selection: 'none',
    credentials: 'routed',
    conflict: 'ANTHROPIC_API_KEY',
    signInFile: null,
    outcome: 'guest_env_conflict',
  },
  {
    selection: 'none',
    credentials: 'routed',
    conflict: null,
    signInFile: null,
    outcome: 'route_required',
  },
  {
    selection: 'none',
    credentials: 'stored-token',
    conflict: 'settings.apiKeyHelper',
    signInFile: 'claude-oauth-token',
    outcome: 'guest_env_conflict',
  },
  {
    selection: 'optional',
    credentials: 'stored-token',
    conflict: null,
    signInFile: 'claude-oauth-token',
    outcome: 'auth_on_stored_token',
  },
  {
    selection: 'none',
    credentials: 'stored-token',
    conflict: null,
    signInFile: null,
    outcome: 'sign_in_unsupported',
  },
  {
    selection: 'optional',
    credentials: 'none',
    conflict: null,
    signInFile: null,
    outcome: 'none',
  },
  {
    selection: 'none',
    credentials: 'none',
    conflict: null,
    signInFile: null,
    outcome: 'none',
  },
  {
    selection: 'none',
    credentials: 'broker',
    conflict: null,
    signInFile: null,
    outcome: 'none',
  },
  {
    selection: 'required',
    credentials: 'broker',
    conflict: null,
    signInFile: null,
    outcome: 'broker',
  },
  {
    selection: 'optional',
    credentials: 'routed',
    conflict: null,
    signInFile: null,
    outcome: 'routed',
  },
  {
    selection: 'none',
    credentials: 'stored-token',
    conflict: null,
    signInFile: 'claude-oauth-token',
    outcome: 'stored-token',
  },
])(
  'it decides $outcome for $credentials credentials, the $selection auth selection, conflict $conflict and sign-in file $signInFile',
  (row) => {
    const ctx = setupTest();

    expect(
      decideHarnessAuth(
        ctx.selections[row.selection],
        ctx.credentials[row.credentials],
        row.conflict,
        row.signInFile,
      ),
    ).toStrictEqual(ctx.decisions[row.outcome]);
  },
);
