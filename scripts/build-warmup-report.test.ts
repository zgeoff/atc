import { expect, test } from 'bun:test';
import { buildWarmupReport } from './build-warmup-report';

test('it names the step with its duration in whole milliseconds', () => {
  expect(buildWarmupReport('image build', 4210.6)).toBe('docker warm-up: image build took 4211 ms');
});
