import type { ScreenModel } from '../sessions/create-screen-model';

// Output written after the replay renders but before the capture resolves can reach a watcher
// that the replay does not hold.
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
