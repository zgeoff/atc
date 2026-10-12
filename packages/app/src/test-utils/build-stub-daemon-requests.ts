import { waitFor } from './wait-for';

type DaemonAnswer = Readonly<Record<string, unknown>>;

interface StubRequest {
  readonly m: string;
  readonly p: DaemonAnswer;
  readonly resolve: (answer: DaemonAnswer) => void;
}

interface StubDaemonRequestsOptions {
  // A count the client under test raises each time it acts on something,
  // such as a draw or a callback it makes.
  readonly countReactions: () => number;

  // Milliseconds each wait for a request or a reaction lasts before it
  // rejects; five seconds when absent.
  readonly timeoutMs?: number;

  // The clock each wait reads its deadline from; the wall clock when absent.
  readonly now?: () => number;

  // Waits out the pause between a wait's checks; a real sleep when absent.
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * A daemon request channel that answers only when the test says so. Every
 * request sent through `sendRequest` waits until `answer` or
 * `answerOldest` resolves it. Each of those waits for a request under the
 * method to be waiting, resolves the latest or the oldest one, and then
 * waits for the client to react: to send another request, or to raise the
 * count `countReactions` reads. A wait that outlasts `timeoutMs` rejects:
 * with `no <method> request is waiting for an answer` when nothing was
 * sent under the method, and with `nothing reacted to the <method> answer`
 * when the client never reacted. A test that takes the `now` and `wait`
 * of a stub clock steps that timeout without waiting it out. `collectSent` returns the params of every
 * request sent under a method, answered or not, in the order they were
 * sent.
 */
export function buildStubDaemonRequests(options: StubDaemonRequestsOptions) {
  const sent: StubRequest[] = [];

  const answered = new Set<StubRequest>();

  const waitOptions = {
    timeoutMs: options.timeoutMs ?? 5000,
    now: options.now ?? Date.now,
    wait: options.wait ?? Bun.sleep,
  };

  const countAll = () => sent.length + options.countReactions();

  const answerRequest = async (request: Readonly<StubRequest>, value: DaemonAnswer) => {
    const before = countAll();

    answered.add(request);
    request.resolve(value);

    await waitFor(() => {
      if (countAll() <= before) {
        throw new Error(`nothing reacted to the ${request.m} answer`);
      }
    }, waitOptions);
  };

  return {
    sendRequest(m: string, p: DaemonAnswer = {}): Promise<DaemonAnswer> {
      return new Promise((resolve) => {
        sent.push({ m, p, resolve });
      });
    },
    async answer(m: string, value: DaemonAnswer): Promise<void> {
      const request = await waitFor(() => {
        const latest = sent.findLast((r) => r.m === m && !answered.has(r));

        if (latest === undefined) {
          throw new Error(`no ${m} request is waiting for an answer`);
        }

        return latest;
      }, waitOptions);

      await answerRequest(request, value);
    },
    async answerOldest(m: string, value: DaemonAnswer): Promise<void> {
      const request = await waitFor(() => {
        const oldest = sent.find((r) => r.m === m && !answered.has(r));

        if (oldest === undefined) {
          throw new Error(`no ${m} request is waiting for an answer`);
        }

        return oldest;
      }, waitOptions);

      await answerRequest(request, value);
    },
    collectSent(m: string): DaemonAnswer[] {
      return sent.filter((request) => request.m === m).map((request) => request.p);
    },
  };
}
