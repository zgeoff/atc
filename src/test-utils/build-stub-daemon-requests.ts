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
}

/**
 * A daemon request channel that answers only when the test says so. Every
 * request sent through `sendRequest` waits until `answer` or
 * `answerOldest` resolves it. Each of those waits for a request under the
 * method to be waiting, resolves the latest or the oldest one, and then
 * waits for the client to react: to send another request, or to raise the
 * count `countReactions` reads. `collectSent` returns the params of every
 * request sent under a method, answered or not, in the order they were
 * sent.
 */
export function buildStubDaemonRequests(options: StubDaemonRequestsOptions) {
  const sent: StubRequest[] = [];

  const answered = new Set<StubRequest>();

  const countAll = () => sent.length + options.countReactions();

  const resolveAndWait = async (request: Readonly<StubRequest>, value: DaemonAnswer) => {
    const before = countAll();

    answered.add(request);
    request.resolve(value);

    await waitFor(() => {
      if (countAll() <= before) {
        throw new Error(`nothing reacted to the ${request.m} answer`);
      }
    });
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
      });

      await resolveAndWait(request, value);
    },
    async answerOldest(m: string, value: DaemonAnswer): Promise<void> {
      const request = await waitFor(() => {
        const oldest = sent.find((r) => r.m === m && !answered.has(r));

        if (oldest === undefined) {
          throw new Error(`no ${m} request is waiting for an answer`);
        }

        return oldest;
      });

      await resolveAndWait(request, value);
    },
    collectSent(m: string): DaemonAnswer[] {
      return sent.filter((request) => request.m === m).map((request) => request.p);
    },
  };
}
