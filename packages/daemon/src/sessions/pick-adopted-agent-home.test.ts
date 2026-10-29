import { expect, test } from 'bun:test';
import { pickAdoptedAgentHome } from './pick-adopted-agent-home';

test('it keeps the stored home when the start attaches to a running process', () => {
  expect(pickAdoptedAgentHome({ created: false }, '/old-home', '/new-home')).toBe('/old-home');
});

test('it takes the planned home when the start attaches to a process whose home was never stored', () => {
  expect(pickAdoptedAgentHome({ created: false }, undefined, '/new-home')).toBe('/new-home');
});

test('it takes the planned home when the start creates the process', () => {
  expect(pickAdoptedAgentHome({ created: true }, '/old-home', '/new-home')).toBe('/new-home');
});

test('it takes the planned home when the launch reports no start', () => {
  expect(pickAdoptedAgentHome(undefined, '/old-home', '/new-home')).toBe('/new-home');
});

test('it clears the stored home when a created process plans none', () => {
  expect(pickAdoptedAgentHome({ created: true }, '/old-home', undefined)).toBeUndefined();
});
