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

test('it redacts an authorization header with digest parameters whole', () => {
  expect(
    sanitizeDetail('Authorization: Digest username="alice", realm="impd", response="demo-secret"'),
  ).toBe('Authorization: [redacted]');
});

test('it redacts a bare credential scheme value', () => {
  expect(
    sanitizeDetail('proxy rejected Bearer abcdefghijklmnopqrstuvwxyz0123456789 and back'),
  ).toBe('proxy rejected Bearer [redacted] and back');

  expect(sanitizeDetail('sent Basic ZGVtbzpwYXNz over the wire')).toBe(
    'sent Basic [redacted] over the wire',
  );
});

test('it redacts secret-named JSON fields and quoted values whole', () => {
  expect(sanitizeDetail('{"api_key":"demo-secret","password":"demo-pass"}')).toBe(
    '{"api_key":[redacted],"password":[redacted]}',
  );

  expect(sanitizeDetail("password='two word secret'")).toBe('password=[redacted]');
  expect(sanitizeDetail('x-api-key: "two word secret"')).toBe('x-api-key: [redacted]');
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
