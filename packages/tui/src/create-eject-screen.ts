import { ansi } from '@atc/core';
import { match } from 'ts-pattern';
import type { ClientActor } from './build-client-machine';
import type { SessionActions } from './create-session-actions';
import { planTextEdit } from './keys';
import { sendToDaemon } from './send-to-daemon';
import type { RequestLinks } from './send-to-daemon';
import type { SessionKey } from './session-key';
import { drawPicker } from './ui';

// What the eject prompt borrows from the client that owns the screen and the
// daemon connection.
export interface EjectScreenDeps {
  readonly service: ClientActor;
  readonly actions: SessionActions;
  readonly links: RequestLinks;
  readonly isLeaderKey: (buf: Buffer) => boolean;
  readonly showBase: () => void;
  readonly scheduleStatus: () => void;
}

// The prompt that takes the instruction a session runs on headless once it
// is ejected.
export interface EjectScreen {
  readonly open: (key: SessionKey) => void;

  // The session the prompt opened on, so the client can drop the prompt when it leaves the list.
  readonly findTarget: () => SessionKey | null;
  readonly render: () => void;
  readonly applyKey: (buf: Buffer) => void;
}

export function createEjectScreen(deps: EjectScreenDeps): EjectScreen {
  let target: SessionKey | null = null;
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
    // The key was set when the screen opened, so the eject acts on the session it opened on.
    const key = target;

    if (key === null) {
      return;
    }

    try {
      await sendToDaemon(deps.links, key.daemon, 'session.eject', {
        session: key.id,
        ...(instruction === '' ? {} : { prompt: instruction }),
      });
    } catch (error) {
      deps.actions.recordActionFailure(key, error);
    }

    deps.service.send({ type: 'OVERLAY' });
  };

  return {
    open: (key) => {
      target = key;
      input = '';

      process.stdout.write(ansi.clear);

      render();
    },

    render,
    findTarget: () => target,

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
