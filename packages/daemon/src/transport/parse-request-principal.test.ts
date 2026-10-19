import { expect, test } from 'bun:test';
import { parseRequestPrincipal } from './parse-request-principal';

test('it reads the principal a request acts as and its name', () => {
  expect(parseRequestPrincipal({ 'x-atc-as': 'ci', 'x-atc-as-name': 'Build bot' })).toStrictEqual({
    principal: 'ci',
    name: 'Build bot',
  });
});

test('it reads a principal without a name', () => {
  expect(parseRequestPrincipal({ 'x-atc-as': 'ci' })).toStrictEqual({
    principal: 'ci',
    name: undefined,
  });
});

test('it reads no principal from a request that gives none', () => {
  expect(parseRequestPrincipal({})).toBeNull();
});

test.each([
  ['an empty principal', { 'x-atc-as': '' }, 'as must be a non-empty string'],
  ['a repeated principal', { 'x-atc-as': ['ci', 'ops'] }, 'as must be a non-empty string'],
  ['an empty name', { 'x-atc-as': 'ci', 'x-atc-as-name': '' }, 'asName must be a non-empty string'],
  ['a name without a principal', { 'x-atc-as-name': 'Build bot' }, 'asName needs as'],
])('it refuses %s', (_label, headers, message) => {
  expect(() => parseRequestPrincipal(headers)).toThrow(
    expect.objectContaining({ code: 'bad_args', message }),
  );
});
