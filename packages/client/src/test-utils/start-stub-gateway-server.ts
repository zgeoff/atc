export interface StubGatewayRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

type StubGatewayAnswer = (request: StubGatewayRequest) => Response | Promise<Response>;

// A real HTTP server on the loopback interface that answers the n-th request with the n-th answer
// and records each request as the client sent it. A request past the last answer gets a 500.
export function startStubGatewayServer(answers: readonly StubGatewayAnswer[]) {
  const requests: StubGatewayRequest[] = [];

  const answerRequest = async (request: Request): Promise<Response> => {
    const text = await request.text();

    const recorded: StubGatewayRequest = {
      url: new URL(request.url).pathname,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: text === '' ? null : JSON.parse(text),
    };

    requests.push(recorded);

    const answer = answers[requests.length - 1];

    if (answer === undefined) {
      return new Response(`the test gave no answer for request ${requests.length}`, {
        status: 500,
      });
    }

    return answer(recorded);
  };

  const server = Bun.serve({ port: 0, fetch: answerRequest });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}
