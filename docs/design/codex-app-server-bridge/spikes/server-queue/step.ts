// One run step against an App Server: bun step.ts <url> <log> <command> [args...]
import { buildText, openClient } from './open-client';

const [url, log, command, ...args] = process.argv.slice(2);

const c = await openClient(url!, log!, command!);

const isTurnDone = (id: string) => (n: any) =>
  n.method === 'turn/completed' && n.params?.turn?.id === id;

async function main() {
  switch (command) {
    case 'start-thread': {
      // [cwd]
      const r = await c.sendRequest('thread/start', {
        cwd: args[0],
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        developerInstructions: 'Keep every reply to one short line.',
      });

      const id = r.thread.id;

      await c.sendRequest('thread/inject_items', {
        threadId: id,
        items: [
          {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'run setup' }],
          },
        ],
      });

      console.log(id);
      break;
    }
    case 'add': {
      // <thread> <clientId> <text>
      const r = await c.sendRequest('thread/queue/add', {
        threadId: args[0],
        input: buildText(args[2]!),
        clientUserMessageId: args[1],
      });

      console.log(JSON.stringify(r));
      break;
    }
    case 'list': {
      const r = await c.sendRequest('thread/queue/list', { threadId: args[0] });

      console.log(
        JSON.stringify(
          r.data.map((s: any) => ({
            id: s.id,
            clientUserMessageId: s.clientUserMessageId,
            text: s.input[0]?.text,
          })),
        ),
      );

      break;
    }
    case 'delete': {
      const r = await c.sendRequest('thread/queue/delete', {
        threadId: args[0],
        queuedSubmissionId: args[1],
      });

      console.log(JSON.stringify(r));
      break;
    }
    case 'resume-watch': {
      // <thread> <seconds>: resume, then log what happens for <seconds>
      await c.sendRequest('thread/resume', { threadId: args[0], excludeTurns: true });
      await Bun.sleep(Number(args[1]) * 1000);

      break;
    }
    case 'watch': {
      await Bun.sleep(Number(args[0]) * 1000);

      break;
    }
    case 'busy-then-add': {
      // <thread> <clientId> <text> <after>: start a slow turn, queue a message
      // while it runs, then wait for <after> = complete|interrupt|kill.
      await c.sendRequest('thread/resume', { threadId: args[0], excludeTurns: true });

      const t = await c.sendRequest('turn/start', {
        threadId: args[0],
        input: buildText('Run the shell command `sleep 12`, then reply with the word FIRST.'),
      });

      await c.waitFor(
        (n) => n.method === 'item/started' && n.params?.item?.type === 'commandExecution',
        60_000,
      );

      await c.sendRequest('thread/queue/add', {
        threadId: args[0],
        input: buildText(args[2]!),
        clientUserMessageId: args[1],
      });

      await c.sendRequest('thread/queue/list', { threadId: args[0] });

      if (args[3] === 'interrupt') {
        await c.sendRequest('turn/interrupt', { threadId: args[0], turnId: t.turn.id });
        await c.waitFor(isTurnDone(t.turn.id), 60_000);
        await Bun.sleep(25_000);
        await c.sendRequest('thread/queue/list', { threadId: args[0] });
      } else if (args[3] === 'kill') {
        console.log(`TURN ${t.turn.id}`);

        // the shell kills the server while the command runs
        await Bun.sleep(60_000);
      } else {
        await c.waitFor(isTurnDone(t.turn.id), 120_000);

        const next = await c.waitFor(
          (n) => n.method === 'turn/started' && n.params?.turn?.id !== t.turn.id,
          30_000,
        );

        await c.waitFor(isTurnDone(next.params.turn.id), 120_000);
        await c.sendRequest('thread/queue/list', { threadId: args[0] });
      }

      break;
    }
    case 'resume-until-turn': {
      // <thread> <seconds>: resume and wait for a dispatched queue turn to finish
      await c.sendRequest('thread/resume', { threadId: args[0], excludeTurns: true });

      const started = await c.waitFor((n) => n.method === 'turn/started', Number(args[1]) * 1000);

      await c.waitFor(isTurnDone(started.params.turn.id), 120_000);
      await c.sendRequest('thread/queue/list', { threadId: args[0] });

      break;
    }
    case 'turns': {
      const r = await c.sendRequest('thread/turns/list', { threadId: args[0], itemsView: 'full' });

      for (const t of r.data) {
        const users = (t.items ?? [])
          .filter((i: any) => i.type === 'userMessage')
          .map((i: any) => i.clientId);

        const last = (t.items ?? []).filter((i: any) => i.type === 'agentMessage').at(-1)?.text;

        console.log(
          JSON.stringify({ turn: t.id, status: t.status, clientIds: users, reply: last }),
        );
      }

      break;
    }
    default:
      throw new Error(`unknown command ${command}`);
  }
}

try {
  await main();
} catch (error) {
  console.log(`ERROR ${JSON.stringify(error)}`);
} finally {
  c.close();
  process.exit(0);
}
