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

test.each([
  ['Authorization: Basic ZGVtbzpwYXNz', 'Authorization: [redacted]'],
  ['authorization: Bearer abc123', 'authorization: [redacted]'],
])('it redacts the whole authorization header value in %p', (detail, sanitized) => {
  expect(sanitizeDetail(detail)).toBe(sanitized);
});

test('it redacts an authorization header with digest parameters whole', () => {
  expect(
    sanitizeDetail('Authorization: Digest username="alice", realm="impd", response="demo-secret"'),
  ).toBe('Authorization: [redacted]');
});

test.each([
  [
    'proxy rejected Bearer abcdefghijklmnopqrstuvwxyz0123456789 and back',
    'proxy rejected Bearer [redacted] and back',
  ],
  ['sent Basic ZGVtbzpwYXNz over the wire', 'sent Basic [redacted] over the wire'],
])('it redacts the bare credential scheme value in %p', (detail, sanitized) => {
  expect(sanitizeDetail(detail)).toBe(sanitized);
});

test.each([
  [
    '{"api_key":"demo-secret","password":"demo-pass"}',
    '{"api_key":[redacted],"password":[redacted]}',
  ],
  ["password='two word secret'", 'password=[redacted]'],
  ['x-api-key: "two word secret"', 'x-api-key: [redacted]'],
])('it redacts the secret-named field or quoted value whole in %p', (detail, sanitized) => {
  expect(sanitizeDetail(detail)).toBe(sanitized);
});

test('it redacts a JSON value that carries an escaped quote', () => {
  expect(sanitizeDetail(String.raw`{"api_key":"de\"mo-secret"}`)).toBe('{"api_key":[redacted]}');
});

test('it redacts a quoted JSON authorization field whole', () => {
  expect(sanitizeDetail('{"Authorization": "Basic ZGVtbzpwYXNz"}')).toBe(
    '{"Authorization": [redacted]}',
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
