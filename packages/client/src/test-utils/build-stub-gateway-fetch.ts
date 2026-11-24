export interface StubGatewayRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

type StubGatewayAnswer = (request: StubGatewayRequest) => Response | Promise<Response>;

// A fetch that answers the n-th request with the n-th answer and records each request as the
// client sent it. A request past the last answer is a failure of the test.
export function buildStubGatewayFetch(answers: readonly StubGatewayAnswer[]) {
  const requests: StubGatewayRequest[] = [];

  const answerRequest = async (input: Request | string | URL): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input));

    const text = await request.text();

    const recorded: StubGatewayRequest = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: text === '' ? null : JSON.parse(text),
    };

    requests.push(recorded);

    const answer = answers[requests.length - 1];

    if (answer === undefined) {
      throw new Error(`the test gave no answer for request ${requests.length}`);
    }

    return answer(recorded);
  };

  const stubFetch: typeof fetch = Object.assign(answerRequest, { preconnect: () => {} });

  return { fetch: stubFetch, requests };
}
