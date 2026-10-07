import { expect, test } from 'bun:test';
import { getRecord } from '../shared/get-record';
import { isRecord } from '../shared/report';
import { buildCodexAuthFile } from './build-codex-auth-file';

test('it writes a ChatGPT sign-in whose tokens are the placeholder and whose refresh lies far ahead', () => {
  const file: unknown = JSON.parse(
    buildCodexAuthFile(
      {
        email: 'someone@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: '5f0c1d7e-0000-4000-8000-00000000c0de',
          chatgpt_plan_type: 'pro',
        },
      },
      '5f0c1d7e-0000-4000-8000-00000000c0de',
    ),
  );

  expect(file).toStrictEqual({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token:
        'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJlbWFpbCI6InNvbWVvbmVAZXhhbXBsZS5jb20iLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiNWYwYzFkN2UtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDBjMGRlIiwiY2hhdGdwdF9wbGFuX3R5cGUiOiJwcm8ifX0.aW1wLWJyb2tlci1wbGFjZWhvbGRlcg',
      access_token: 'imp-broker-placeholder',
      refresh_token: 'imp-broker-placeholder',
      account_id: '5f0c1d7e-0000-4000-8000-00000000c0de',
    },
    last_refresh: '2099-01-01T00:00:00Z',
  });
});

test('it writes an unsigned ID token of three segments that holds only the email and the OpenAI auth claims', () => {
  const file: unknown = JSON.parse(
    buildCodexAuthFile(
      {
        email: 'someone@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: '5f0c1d7e-0000-4000-8000-00000000c0de',
          chatgpt_plan_type: 'pro',
        },
        'https://api.openai.com/profile': { email: 'someone@example.com' },
        iss: 'https://auth.example.com',
        sub: 'user-1',
        exp: 1_900_000_000,
      },
      '5f0c1d7e-0000-4000-8000-00000000c0de',
    ),
  );

  if (!isRecord(file)) {
    throw new TypeError('the sign-in file is not an object');
  }

  const idToken = getRecord(file, 'tokens')['id_token'];

  if (typeof idToken !== 'string') {
    throw new TypeError('the sign-in file holds no ID token');
  }

  const segments = idToken.split('.');
  const header: unknown = JSON.parse(Buffer.from(segments[0] ?? '', 'base64url').toString('utf8'));
  const payload: unknown = JSON.parse(Buffer.from(segments[1] ?? '', 'base64url').toString('utf8'));

  expect({
    count: segments.length,
    header,
    payload,
    signature: Buffer.from(segments[2] ?? '', 'base64url').toString('utf8'),
  }).toStrictEqual({
    count: 3,
    header: { alg: 'none', typ: 'JWT' },
    payload: {
      email: 'someone@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: '5f0c1d7e-0000-4000-8000-00000000c0de',
        chatgpt_plan_type: 'pro',
      },
    },
    signature: 'imp-broker-placeholder',
  });
});

test('it leaves out a kept claim that the ID token lacks', () => {
  const file: unknown = JSON.parse(
    buildCodexAuthFile({ 'https://api.openai.com/auth': { chatgpt_account_id: 'a' } }, 'a'),
  );

  if (!isRecord(file)) {
    throw new TypeError('the sign-in file is not an object');
  }

  const idToken = getRecord(file, 'tokens')['id_token'];

  if (typeof idToken !== 'string') {
    throw new TypeError('the sign-in file holds no ID token');
  }

  const payload = Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8');
  const claims: unknown = JSON.parse(payload);

  expect(claims).toStrictEqual({
    'https://api.openai.com/auth': { chatgpt_account_id: 'a' },
  });
});

test('it writes an access token that is not a JWT, so Codex never refreshes it at start', () => {
  const file: unknown = JSON.parse(
    buildCodexAuthFile(
      {
        email: 'someone@example.com',
        'https://api.openai.com/auth': { chatgpt_account_id: 'a', chatgpt_plan_type: 'pro' },
      },
      'a',
    ),
  );

  if (!isRecord(file)) {
    throw new TypeError('the sign-in file is not an object');
  }

  const accessToken = getRecord(file, 'tokens')['access_token'];

  if (typeof accessToken !== 'string') {
    throw new TypeError('the sign-in file holds no access token');
  }

  expect(accessToken).not.toInclude('.');
});
