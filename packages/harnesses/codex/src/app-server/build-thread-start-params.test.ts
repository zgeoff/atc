import { expect, test } from 'bun:test';
import { buildThreadStartParams } from './build-thread-start-params';

test('it starts the thread in the folder with the atc tools and the session in its instructions', () => {
  const params = buildThreadStartParams('s-1', '/work/repo');

  expect(params.cwd).toBe('/work/repo');
  expect(params.developerInstructions).toStartWith('This thread is atc session s-1.');
  expect(params.dynamicTools.map((namespace) => namespace.name)).toStrictEqual(['atc']);
  expect(params.dynamicTools[0]?.tools.map((tool) => tool.name)).toStrictEqual(['note', 'answer']);
});

test('it starts the thread on the model the spawn asked for', () => {
  expect(buildThreadStartParams('s-1', '/work/repo', 'gpt-test-large').model).toBe(
    'gpt-test-large',
  );
});

test('it leaves the model to the server when the spawn asked for none', () => {
  expect(buildThreadStartParams('s-1', '/work/repo')).not.toContainKey('model');
});
