import { ansi } from '@atc/core';
import type { DaemonClient } from '@atc/protocol/client';
import { match } from 'ts-pattern';
import type { ClientActor } from './build-client-machine';
import type { SessionActions } from './create-session-actions';
import { planTextEdit } from './keys';
import { drawPicker } from './ui';

// What the eject prompt borrows from the client that owns the screen and the
// daemon connection.
export interface EjectScreenDeps {
  readonly service: ClientActor;
  readonly actions: SessionActions;
  readonly getClient: () => DaemonClient;
  readonly isLeaderKey: (buf: Buffer) => boolean;
  readonly showBase: () => void;
  readonly scheduleStatus: () => void;
}

// The prompt that takes the instruction a session runs on headless once it
// is ejected.
export interface EjectScreen {
  readonly open: (sessionID: string) => void;
  readonly render: () => void;
  readonly applyKey: (buf: Buffer) => void;
}

export function createEjectScreen(deps: EjectScreenDeps): EjectScreen {
  let target = '';
  let input = '';

  const render = () => {
    drawPicker({
      title: 'eject: headless instruction',
      items: [],
      selected: -1,
      input,
      placeholder: 'continue the task autonomously',
      hint: 'instruction for the headless run · ⏎ eject · esc back',
    });

    deps.scheduleStatus();
  };

  const yankToHeadless = async (instruction: string) => {
    try {
      await deps.getClient().sendRequest('session.eject', {
        session: target,
        ...(instruction === '' ? {} : { prompt: instruction }),
      });
    } catch (error) {
      deps.actions.recordActionFailure(target, error);
    }

    deps.service.send({ type: 'OVERLAY' });
  };

  return {
    open: (sessionID) => {
      target = sessionID;
      input = '';

      process.stdout.write(ansi.clear);

      render();
    },

    render,

    applyKey: (buf) => {
      const edit = planTextEdit(buf, input, {
        isLeaderKey: deps.isLeaderKey,
        moves: false,
      });

      match(edit)
        .with({ kind: 'none' }, { kind: 'move' }, () => {})
        .with({ kind: 'cancel' }, () => {
          deps.service.send({ type: 'OVERLAY' });
        })
        .with({ kind: 'leader' }, () => {
          deps.showBase();
        })
        .with({ kind: 'submit' }, (submit) => {
          input = submit.value;
          void yankToHeadless(input.trim());
        })
        .with({ kind: 'input' }, (inputEdit) => {
          input = inputEdit.value;

          render();
        })
        .exhaustive();
    },
  };
}
