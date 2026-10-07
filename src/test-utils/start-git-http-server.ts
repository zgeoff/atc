interface GitHTTPServer {
  // The base URL a repository under the root is served at, ending in `/`.
  readonly url: string;

  // Every Authorization header a request carried, in arrival order.
  readonly authorizations: string[];
  readonly stop: () => Promise<void>;
}

/**
 * Serves the bare repositories under a directory over smart HTTP through
 * `git http-backend` on a loopback port, and refuses every request that
 * carries no basic auth, so a client only clones by authenticating. The
 * backend runs with the environment it is given. With a delay, each
 * authenticated request waits that long before it is served, which makes a
 * clone through it slow.
 */
export function startGitHTTPServer(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly delayMs?: number } = {},
): GitHTTPServer {
  const authorizations: string[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const authorization = request.headers.get('authorization');

      if (authorization === null) {
        return new Response('auth required', {
          status: 401,
          headers: { 'www-authenticate': 'Basic realm="atc"' },
        });
      }

      authorizations.push(authorization);

      if (options.delayMs !== undefined) {
        await Bun.sleep(options.delayMs);
      }

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
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/`,
    authorizations,
    stop: () => server.stop(true),
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
