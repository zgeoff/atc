import { expect, test } from 'bun:test';
import { sanitizeDetail } from './sanitize-detail';

test('it redacts URL userinfo and secret-named query values however short', () => {
  expect(sanitizeDetail('https://alice:demo-pass@api.example.test/v1?api_key=demo-secret')).toBe(
    'https://[redacted]@api.example.test/v1?api_key=[redacted]',
  );
});

test('it redacts secret-named header values however short', () => {
  expect(sanitizeDetail('x-api-key: demo-secret')).toBe('x-api-key: [redacted]');
});

test('it redacts a whole authorization header value', () => {
  expect(sanitizeDetail('Authorization: Basic ZGVtbzpwYXNz')).toBe('Authorization: [redacted]');
  expect(sanitizeDetail('authorization: Bearer abc123')).toBe('authorization: [redacted]');
});

test('it redacts a bare credential scheme value', () => {
  expect(
    sanitizeDetail('proxy rejected Bearer abcdefghijklmnopqrstuvwxyz0123456789 and back'),
  ).toBe('proxy rejected Bearer [redacted] and back');

  expect(sanitizeDetail('sent Basic ZGVtbzpwYXNz over the wire')).toBe(
    'sent Basic [redacted] over the wire',
  );
});

test('it redacts long credential-shaped runs', () => {
  expect(sanitizeDetail('key 0123456789abcdef0123456789abcdef')).toBe('key [redacted]');
});

test('it keeps ordinary text unchanged', () => {
  expect(sanitizeDetail('exec-session-ended after 3 attempts')).toBe(
    'exec-session-ended after 3 attempts',
  );
});
