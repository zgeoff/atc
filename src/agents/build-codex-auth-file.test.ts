import { expect, test } from 'bun:test';
import { getRecord } from '../shared/get-record';
import { isRecord } from '../shared/report';
import { buildCodexAuthFile } from './build-codex-auth-file';

const ACCOUNT_ID = '5f0c1d7e-0000-4000-8000-00000000c0de';

const CLAIMS = {
  email: 'someone@example.com',
  'https://api.openai.com/auth': {
    chatgpt_account_id: ACCOUNT_ID,
    chatgpt_plan_type: 'pro',
  },
  'https://api.openai.com/profile': { email: 'someone@example.com' },
  iss: 'https://auth.example.com',
  sub: 'user-1',
  exp: 1_900_000_000,
};

function decodeSegment(segment: string | undefined): unknown {
  return JSON.parse(Buffer.from(segment ?? '', 'base64url').toString('utf8'));
}

function toRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new TypeError('the sign-in file is not an object');
  }

  return value;
}

// The tokens object of a written sign-in file.
function getTokens(file: string): Readonly<Record<string, unknown>> {
  return getRecord(toRecord(JSON.parse(file)), 'tokens');
}

test('it writes a ChatGPT sign-in whose tokens are the placeholder and whose refresh lies far ahead', () => {
  const file = toRecord(JSON.parse(buildCodexAuthFile(CLAIMS, ACCOUNT_ID)));
  const tokens = getRecord(file, 'tokens');

  expect({ file, idToken: typeof tokens['id_token'] }).toStrictEqual({
    file: {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: tokens['id_token'],
        access_token: 'imp-broker-placeholder',
        refresh_token: 'imp-broker-placeholder',
        account_id: ACCOUNT_ID,
      },
      last_refresh: '2099-01-01T00:00:00Z',
    },
    idToken: 'string',
  });
});

test('it writes an unsigned ID token of three segments that holds only the email and the OpenAI auth claims', () => {
  const idToken = String(getTokens(buildCodexAuthFile(CLAIMS, ACCOUNT_ID))['id_token']);
  const segments = idToken.split('.');

  expect({
    count: segments.length,
    header: decodeSegment(segments[0]),
    payload: decodeSegment(segments[1]),
    signature: Buffer.from(segments[2] ?? '', 'base64url').toString('utf8'),
  }).toStrictEqual({
    count: 3,
    header: { alg: 'none', typ: 'JWT' },
    payload: {
      email: 'someone@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: ACCOUNT_ID,
        chatgpt_plan_type: 'pro',
      },
    },
    signature: 'imp-broker-placeholder',
  });
});

test('it leaves out a kept claim that the ID token lacks', () => {
  const file = buildCodexAuthFile(
    { 'https://api.openai.com/auth': { chatgpt_account_id: 'a' } },
    'a',
  );

  const idToken = String(getTokens(file)['id_token']);

  expect(decodeSegment(idToken.split('.')[1])).toStrictEqual({
    'https://api.openai.com/auth': { chatgpt_account_id: 'a' },
  });
});

test('it writes an access token that is not a JWT, so Codex never refreshes it at start', () => {
  const tokens = getTokens(buildCodexAuthFile(CLAIMS, ACCOUNT_ID));

  expect(String(tokens['access_token'])).not.toContain('.');
});
