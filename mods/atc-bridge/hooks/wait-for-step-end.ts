import type { BridgeState } from './bridge-state.ts';

// A hold that ends lets the next delivery go, which a step that starts at once
// can hold again.
export async function waitForStepEnd(state: BridgeState): Promise<void> {
  while (state.stepHold !== null) {
    await state.stepHold.ended;
  }
}
