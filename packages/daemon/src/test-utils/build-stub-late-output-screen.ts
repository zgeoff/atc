import type { ScreenModel } from '../sessions/create-screen-model';

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
