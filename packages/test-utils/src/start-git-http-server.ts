import { registerTestCleanup } from './register-test-cleanup';

interface GitHTTPServer {
  // The base URL a repository under the root is served at, ending in `/`.
  readonly url: string;

  // Every Authorization header a request carried, in arrival order.
  readonly authorizations: string[];
  readonly stop: () => Promise<void>;
}

interface GitHTTPServerOptions {
  // How long each authenticated request waits before it is served.
  readonly delayMs?: number;

  // Waits out the delay; a timer unless given.
  readonly wait?: (ms: number) => Promise<void>;

  // Runs, and is awaited, while each authenticated request is held.
  readonly onRequest?: () => Promise<void> | void;
}

export function startGitHTTPServer(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  options: GitHTTPServerOptions = {},
): GitHTTPServer {
  const wait = options.wait ?? Bun.sleep;
  const authorizations: string[] = [];

  const answerRequest = async (request: Request) => {
    const authorization = request.headers.get('authorization');

    if (authorization === null) {
      return new Response('auth required', {
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="atc"' },
      });
    }

    authorizations.push(authorization);

    if (options.delayMs !== undefined) {
      await wait(options.delayMs);
    }

    await options.onRequest?.();

    const url = new URL(request.url);

    const body = await request.arrayBuffer();

    const backend = Bun.spawn(['git', 'http-backend'], {
      env: {
        ...env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: request.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers.get('content-type') ?? '',
        HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
        HTTP_GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
        REMOTE_USER: 'atc',
        REMOTE_ADDR: '127.0.0.1',
      },
      stdin: new Uint8Array(body),
      stdout: 'pipe',
      stderr: 'ignore',
    });

    const raw = await new Response(backend.stdout).arrayBuffer();

    return toCGIResponse(Buffer.from(raw));
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: answerRequest,
  });

  const stop = registerTestCleanup(() => server.stop(true));

  return {
    url: `http://127.0.0.1:${server.port}/`,
    authorizations,
    stop,
  };
}

// A CGI answer is a header block, a blank line, and the body; a `Status`
// header sets the response status.
function toCGIResponse(output: Buffer): Response {
  const split = output.indexOf('\r\n\r\n');

  const headers = new Headers();

  let status = 200;

  for (const line of output.subarray(0, split).toString('latin1').split('\r\n')) {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    if (name.toLowerCase() === 'status') {
      status = Number(value.split(' ')[0]);
    } else {
      headers.append(name, value);
    }
  }

  return new Response(output.subarray(split + 4), { status, headers });
}
