import { waitFor } from './wait-for';

type DaemonAnswer = Readonly<Record<string, unknown>>;

interface StubRequest {
  readonly method: string;
  readonly params: DaemonAnswer;
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
  readonly wait?: (delayMs: number) => Promise<void>;
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
        throw new Error(`nothing reacted to the ${request.method} answer`);
      }
    }, waitOptions);
  };

  const waitForLatest = (method: string) =>
    waitFor(() => {
      const latest = sent.findLast(
        (candidate) => candidate.method === method && !answered.has(candidate),
      );

      if (latest === undefined) {
        throw new Error(`no ${method} request is waiting for an answer`);
      }

      return latest;
    }, waitOptions);

  return {
    sendRequest(method: string, params: DaemonAnswer = {}): Promise<DaemonAnswer> {
      return new Promise((resolve, reject) => {
        sent.push({ method, params, resolve, reject });
      });
    },
    async answer(method: string, value: DaemonAnswer): Promise<void> {
      const request = await waitForLatest(method);

      await answerRequest(request, () => {
        request.resolve(value);
      });
    },
    async refuse(method: string, error: unknown): Promise<void> {
      const request = await waitForLatest(method);

      await answerRequest(request, () => {
        request.reject(error);
      });
    },
    async answerOldest(method: string, value: DaemonAnswer): Promise<void> {
      const request = await waitFor(() => {
        const oldest = sent.find(
          (candidate) => candidate.method === method && !answered.has(candidate),
        );

        if (oldest === undefined) {
          throw new Error(`no ${method} request is waiting for an answer`);
        }

        return oldest;
      }, waitOptions);

      await answerRequest(request, () => {
        request.resolve(value);
      });
    },
    collectSent(method: string): DaemonAnswer[] {
      return sent.filter((request) => request.method === method).map((request) => request.params);
    },
  };
}
