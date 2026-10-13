import { expect, test } from 'bun:test';
import { findCodexSignIn } from './find-codex-sign-in';

test('it reads the ID token claims and the ChatGPT account id of a ready secret', () => {
  const idClaims = {
    email: 'someone@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: '5f0c1d7e-0000-4000-8000-00000000c0de',
      chatgpt_plan_type: 'pro',
    },
  };

  expect(findCodexSignIn({ status: 'ready', idClaims })).toStrictEqual({
    idClaims,
    accountID: '5f0c1d7e-0000-4000-8000-00000000c0de',
  });
});

test('it finds no sign-in for a secret impd does not list', () => {
  expect(findCodexSignIn(undefined)).toBeNull();
});

test('it finds no sign-in for a secret whose sign-in is pending or needs a login', () => {
  const idClaims = {
    'https://api.openai.com/auth': { chatgpt_account_id: '5f0c1d7e-0000-4000-8000-00000000c0de' },
  };

  expect([
    findCodexSignIn({ status: 'pending', idClaims: null }),
    findCodexSignIn({ status: 'needs_login', idClaims }),
  ]).toStrictEqual([null, null]);
});

test('it finds no sign-in for a ready secret whose ID token holds no ChatGPT account id', () => {
  expect([
    findCodexSignIn({ status: 'ready', idClaims: null }),
    findCodexSignIn({ status: 'ready', idClaims: { email: 'someone@example.com' } }),
    findCodexSignIn({
      status: 'ready',
      idClaims: { 'https://api.openai.com/auth': { chatgpt_account_id: '' } },
    }),
  ]).toStrictEqual([null, null, null]);
});
