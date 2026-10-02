import { expect, test } from 'bun:test';
import { parseDaemonFeatures } from './parse-daemon-features';

test('it reads the features a hello answer announces', () => {
  const features = parseDaemonFeatures({
    daemon: 'atc/x',
    features: ['message.wait', 'agents.list'],
  });

  expect([...features]).toStrictEqual(['agents.list', 'message.wait']);
});

test('it reads a hello answer without a feature list as no features', () => {
  expect(parseDaemonFeatures({ daemon: 'atc/old' }).size).toBe(0);
});

test('it drops a feature name this build does not know', () => {
  const features = parseDaemonFeatures({ features: ['message.wait', 'teleport', 42] });

  expect([...features]).toStrictEqual(['message.wait']);
});
