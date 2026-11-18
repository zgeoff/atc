import { expect, test } from 'bun:test';
import { buildStubClientScreens } from './build-stub-client-screens';

test('it records no call before a screen opens', () => {
  expect(buildStubClientScreens().calls).toStrictEqual([]);
});

test('it records each screen it opens or closes with its argument, in the order they come', () => {
  const stub = buildStubClientScreens();

  stub.deps.openHome();
  stub.deps.openAttached({ daemon: null, id: 's1' });
  stub.deps.closeAttached();
  stub.deps.openOverlay();
  stub.deps.openHelp();
  stub.deps.openPicker(true);
  stub.deps.openEject({ daemon: null, id: 's2' });

  expect(stub.calls).toStrictEqual([
    'openHome',
    'openAttached:s1',
    'closeAttached',
    'openOverlay',
    'openHelp',
    'openPicker:true',
    'openEject:s2',
  ]);
});
