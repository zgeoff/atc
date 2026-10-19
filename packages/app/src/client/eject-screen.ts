import { ansi } from '@atc/core';
import type { DaemonClient } from '@atc/protocol/client';
import type { ClientActor } from './build-client-machine';
import { planTextEdit } from './keys';
import type { SessionActions } from './session-actions';
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
export class EjectScreen {
  private target = '';

  private input = '';

  private readonly deps: EjectScreenDeps;

  constructor(deps: EjectScreenDeps) {
    this.deps = deps;
  }

  open(sessionID: string) {
    this.target = sessionID;
    this.input = '';

    process.stdout.write(ansi.clear);
    this.render();
  }

  render() {
    drawPicker({
      title: 'eject: headless instruction',
      items: [],
      selected: -1,
      input: this.input,
      placeholder: 'continue the task autonomously',
      hint: 'instruction for the headless run · ⏎ eject · esc back',
    });

    this.deps.scheduleStatus();
  }

  applyKey(buf: Buffer) {
    const edit = planTextEdit(buf, this.input, {
      isLeaderKey: this.deps.isLeaderKey,
      moves: false,
    });

    switch (edit.kind) {
      case 'none':
      case 'move': {
        return;
      }
      case 'cancel': {
        this.deps.service.send({ type: 'OVERLAY' });

        return;
      }
      case 'leader': {
        this.deps.showBase();

        return;
      }
      case 'submit': {
        this.input = edit.value;
        void this.yankToHeadless(this.input.trim());

        return;
      }
      case 'input': {
        this.input = edit.value;

        this.render();
      }
    }
  }

  private async yankToHeadless(instruction: string) {
    try {
      await this.deps.getClient().sendRequest('session.eject', {
        session: this.target,
        ...(instruction === '' ? {} : { prompt: instruction }),
      });
    } catch (error) {
      this.deps.actions.recordActionFailure(this.target, error);
    }

    this.deps.service.send({ type: 'OVERLAY' });
  }
}
