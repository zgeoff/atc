import invariant from 'tiny-invariant';

// A daemon test fails on an `internal` error with no sign of its cause, which only the
// daemon's stderr holds, and a refusal of any other code is an answer a test expects.
export function buildStderrReportingClient<T extends object>(
  client: T,
  readStderr: () => string,
  writeReport: (text: string) => void,
): T {
  const reportRejection = async (pending: Promise<unknown>): Promise<unknown> => {
    try {
      return await pending;
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, 'code') === 'internal') {
        writeReport(`the daemon answered an internal error; its stderr:\n${readStderr()}`);
      }

      throw error;
    }
  };

  const wrap = <V extends object>(target: V): V =>
    new Proxy(target, {
      get: (object, key) => {
        const value: unknown = Reflect.get(object, key);

        return typeof value === 'function' || isRecord(value) ? wrap(value) : value;
      },
      apply: (callable, thisArgument, argumentList: unknown[]) => {
        invariant(typeof callable === 'function', 'only a function proxy is called');

        const result: unknown = Reflect.apply(callable, thisArgument, argumentList);

        return result instanceof Promise ? reportRejection(result) : result;
      },
    });

  return wrap(client);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !(value instanceof Promise);
}
