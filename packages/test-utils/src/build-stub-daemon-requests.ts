import { waitFor } from './wait-for';

type DaemonAnswer = Readonly<Record<string, unknown>>;

interface StubRequest {
  readonly m: string;
  readonly p: DaemonAnswer;
  readonly resolve: (answer: DaemonAnswer) => void;
  readonly reject: (error: unknown) => void;
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

export function buildStubDaemonRequests(options: StubDaemonRequestsOptions) {
  const sent: StubRequest[] = [];

  const answered = new Set<StubRequest>();

  const waitOptions = {
    timeoutMs: options.timeoutMs ?? 5000,
    now: options.now ?? Date.now,
    wait: options.wait ?? Bun.sleep,
  };

  const countAll = () => sent.length + options.countReactions();

  const answerRequest = async (request: Readonly<StubRequest>, settle: () => void) => {
    const before = countAll();

    answered.add(request);

    settle();

    await waitFor(() => {
      if (countAll() <= before) {
        throw new Error(`nothing reacted to the ${request.m} answer`);
      }
    }, waitOptions);
  };

  const waitForLatest = (m: string) =>
    waitFor(() => {
      const latest = sent.findLast((r) => r.m === m && !answered.has(r));

      if (latest === undefined) {
        throw new Error(`no ${m} request is waiting for an answer`);
      }

      return latest;
    }, waitOptions);

  return {
    sendRequest(m: string, p: DaemonAnswer = {}): Promise<DaemonAnswer> {
      return new Promise((resolve, reject) => {
        sent.push({ m, p, resolve, reject });
      });
    },
    async answer(m: string, value: DaemonAnswer): Promise<void> {
      const request = await waitForLatest(m);

      await answerRequest(request, () => {
        request.resolve(value);
      });
    },
    async refuse(m: string, error: unknown): Promise<void> {
      const request = await waitForLatest(m);

      await answerRequest(request, () => {
        request.reject(error);
      });
    },
    async answerOldest(m: string, value: DaemonAnswer): Promise<void> {
      const request = await waitFor(() => {
        const oldest = sent.find((r) => r.m === m && !answered.has(r));

        if (oldest === undefined) {
          throw new Error(`no ${m} request is waiting for an answer`);
        }

        return oldest;
      }, waitOptions);

      await answerRequest(request, () => {
        request.resolve(value);
      });
    },
    collectSent(m: string): DaemonAnswer[] {
      return sent.filter((request) => request.m === m).map((request) => request.p);
    },
  };
}
