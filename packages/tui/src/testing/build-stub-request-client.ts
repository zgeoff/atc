// A daemon that answers each method from the table a test gives, records each method asked, and
// refuses every request when it is built with a failure.
export function buildStubRequestClient(
  answers: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  failure: Error | null = null,
) {
  const asked: string[] = [];

  return {
    asked,
    sendRequest: (method: string): Promise<Readonly<Record<string, unknown>>> => {
      asked.push(method);

      return failure === null ? Promise.resolve(answers[method] ?? {}) : Promise.reject(failure);
    },
  };
}
