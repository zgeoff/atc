import { expect, test } from 'bun:test';
import { buildWarmupReport } from './build-warmup-report';

test('it prints one line per step with its duration in whole milliseconds', () => {
  const report = buildWarmupReport([
    { step: 'image build', durationMs: 4210.6 },
    { step: 'first container', durationMs: 812.2 },
  ]);

  expect(report).toBe(
    'docker warm-up: image build took 4211 ms\ndocker warm-up: first container took 812 ms',
  );
});
