import { expect, test } from 'bun:test';
import { buildStubClientScreens } from './build-stub-client-screens';

test('it records no call before a screen opens', () => {
  expect(buildStubClientScreens().calls).toStrictEqual([]);
});

test('it records each screen it opens with its argument, in the order they open', () => {
  const stub = buildStubClientScreens();

  stub.deps.openHome();
  stub.deps.openAttached('s1');
  stub.deps.openOverlay();
  stub.deps.openHelp();
  stub.deps.openPicker(true);
  stub.deps.openEject('s2');

  expect(stub.calls).toStrictEqual([
    'openHome',
    'openAttached:s1',
    'openOverlay',
    'openHelp',
    'openPicker:true',
    'openEject:s2',
  ]);
});
