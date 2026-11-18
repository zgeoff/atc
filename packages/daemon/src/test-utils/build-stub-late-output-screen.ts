import type { ScreenModel } from '../sessions/create-screen-model';

// A screen whose full replay runs a callback after it renders and before the
// capture resolves: the gap where output can reach a watcher that the replay
// does not hold.
export function buildStubLateOutputScreen(
  screen: ScreenModel,
  onRendered: () => void,
): ScreenModel {
  return {
    ...screen,
    captureFullReplay: async (readMark) => {
      const captured = await screen.captureFullReplay(readMark);

      onRendered();

      return captured;
    },
  };
}
