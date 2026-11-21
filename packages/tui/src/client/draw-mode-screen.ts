import { ansi } from '@atc/core';
import { match } from 'ts-pattern';
import type { EjectScreen } from '../overlay/create-eject-screen';
import type { OverlayScreen } from '../overlay/create-overlay-screen';
import type { SpawnPicker } from '../picker/create-spawn-picker';
import { drawHome } from '../terminal/draw-home';
import type { ClientMode } from './build-client-machine';

export interface DrawModeScreenDeps {
  readonly mode: ClientMode;
  readonly sessionCount: number;
  readonly leaderLabel: string;
  readonly overlay: Pick<OverlayScreen, 'render'>;
  readonly picker: Pick<SpawnPicker, 'render'>;
  readonly eject: Pick<EjectScreen, 'render'>;
  readonly openHelp: () => void;
  readonly write: (chunk: string) => void;
}

export function drawModeScreen(deps: DrawModeScreenDeps): void {
  match(deps.mode)
    .with('home', () => {
      drawHome(deps.sessionCount, deps.leaderLabel);
    })
    .with('overlay', () => {
      deps.overlay.render();
    })
    .with('help', () => {
      deps.openHelp();
    })
    .with('picker', () => {
      deps.write(ansi.clear);
      deps.picker.render();
    })
    .with('picker-eject', () => {
      deps.write(ansi.clear);
      deps.eject.render();
    })
    .with('attached', () => {
      // a session repaints only through the agent, on the resize the daemon passes on.
    })
    .exhaustive();
}
