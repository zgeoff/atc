import { APIError, SpritesClient } from '@fly/sprites';
import { z } from 'zod';
import { WRITE_FILE_SCRIPT } from '../guest-scripts/write-file-script';
import { openExecConnection } from './open-exec-connection';
import { scrubToken } from './scrub-token';
import { SpritesApiError } from './sprites-api-error';
import type { ConnectorView, ExecConnection, SpriteView, SpritesPort } from './types';

interface SpritesApiPortOptions {
  readonly apiURL: string;

  // read on each call, so a token file that rotates is read again
  readonly readToken: () => string;
}

interface HeldClient {
  readonly token: string;
  readonly value: SpritesClient;
}

// the API takes a file of up to 16 MiB through its file endpoint; a larger one goes through an
// exec's stdin
const FILE_ENDPOINT_LIMIT = 15 * 1024 * 1024;
const STDIN_CHUNK = 256 * 1024;
const ACCESS_POLICY_SCHEMA = z.object({ name_prefix: z.string().nullish() });

const CONNECTOR_SCHEMA = z.object({
  id: z.string(),
  provider: z.string(),
  access_policy: ACCESS_POLICY_SCHEMA.nullish(),
});

const CONNECTORS_SCHEMA = z.object({ connections: z.array(CONNECTOR_SCHEMA) });

export function createSpritesApiPort(options: SpritesApiPortOptions): SpritesPort {
  let held: HeldClient | null = null;

  const getClient = (token: string): SpritesClient => {
    if (held?.token !== token) {
      held = { token, value: new SpritesClient(token, { baseURL: options.apiURL }) };
    }

    return held.value;
  };

  // runs a call as the API's failure, with the token scrubbed from what it says
  const guard = async <T>(call: (api: SpritesClient, token: string) => Promise<T>): Promise<T> => {
    const token = options.readToken();

    try {
      return await call(getClient(token), token);
    } catch (error) {
      throw toApiError(error, token);
    }
  };

  const writeThroughExec = async (
    name: string,
    path: string,
    content: Uint8Array,
    mode: number,
  ): Promise<void> => {
    const connection = port.openExec(name, {
      argv: ['sh', '-c', WRITE_FILE_SCRIPT, 'sh', path, mode.toString(8)],
      tty: false,
    });

    const ended = Promise.withResolvers<number>();

    connection.onEnd((end) => {
      const exitCode = end.kind === 'exit' ? end.exitCode : -1;

      ended.resolve(exitCode);
    });

    for (let offset = 0; offset < content.length; offset += STDIN_CHUNK) {
      await connection.write(content.subarray(offset, offset + STDIN_CHUNK));
    }

    connection.endInput();

    const exitCode = await ended.promise;

    if (exitCode !== 0) {
      throw new SpritesApiError(null, `writing ${path} on sprite ${name} exited ${exitCode}`);
    }
  };

  const port: SpritesPort = {
    readSprite: (name) =>
      guard(async (api): Promise<SpriteView | null> => {
        try {
          const sprite = await api.getSprite(name);

          return toSpriteView(sprite);
        } catch (error) {
          if (findErrorStatus(error) === 404) {
            return null;
          }

          throw error;
        }
      }),

    createSprite: (name) =>
      guard(async (api) => {
        const sprite = await api.createSprite(name);

        return toSpriteView(sprite);
      }),

    removeSprite: (name) =>
      guard(async (api) => {
        try {
          await api.deleteSprite(name);
        } catch (error) {
          if (findErrorStatus(error) !== 404) {
            throw error;
          }
        }
      }),

    listExecs: (name) =>
      guard(async (api) => {
        const sessions = await api.sprite(name).listSessions();

        return sessions.map((session) => ({
          id: session.id,
          command: session.command,
          tty: session.tty,
        }));
      }),

    openExec: (name, request): ExecConnection =>
      openExecConnection({
        apiURL: options.apiURL,
        token: options.readToken(),
        sprite: name,
        request,
      }),

    readConnectors: () =>
      guard(async (_api, token): Promise<readonly ConnectorView[]> => {
        const response = await fetch(`${options.apiURL}/v1/oauth/connections`, {
          headers: { authorization: `Bearer ${token}` },
        });

        if (!response.ok) {
          const body = await response.text();

          throw new SpritesApiError(response.status, scrubToken(body, token));
        }

        const json: unknown = await response.json();

        const parsed = CONNECTORS_SCHEMA.parse(json);

        return parsed.connections.map((connector) => ({
          id: connector.id,
          provider: connector.provider,
          namePrefix: connector.access_policy?.name_prefix ?? null,
        }));
      }),

    readFile: (name, path) =>
      guard(async (api) => {
        try {
          const content = await api.sprite(name).filesystem('/').readFile(path, null);

          return new Uint8Array(content);
        } catch (error) {
          if (isMissingFile(error)) {
            return null;
          }

          throw error;
        }
      }),

    writeFile: (name, path, content, mode) =>
      guard(async (api) => {
        if (content.length > FILE_ENDPOINT_LIMIT) {
          await writeThroughExec(name, path, content, mode);

          return;
        }

        const filesystem = api.sprite(name).filesystem('/');

        await filesystem.writeFile(path, Buffer.from(content), { mode });
      }),
  };

  return port;
}

function toApiError(error: unknown, token: string): SpritesApiError {
  if (error instanceof SpritesApiError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  return new SpritesApiError(findErrorStatus(error), scrubToken(message, token));
}

function findErrorStatus(error: unknown): number | null {
  if (error instanceof APIError) {
    return error.statusCode ?? null;
  }

  if (error instanceof SpritesApiError) {
    return error.status;
  }

  const found = error instanceof Error ? /\(status (?<status>\d{3})\)/u.exec(error.message) : null;
  const status = found?.groups?.['status'];

  return status === undefined ? null : Number(status);
}

interface FlySprite {
  readonly id?: string | undefined;
  readonly name: string;
  readonly status?: string | undefined;
}

function toSpriteView(sprite: FlySprite): SpriteView {
  const status = sprite.status === 'running' || sprite.status === 'warm' ? sprite.status : 'cold';

  return { id: sprite.id ?? '', name: sprite.name, status };
}

function isMissingFile(error: unknown): boolean {
  const hasCode = error instanceof Error && 'code' in error && error.code === 'ENOENT';

  return hasCode || findErrorStatus(error) === 404;
}
