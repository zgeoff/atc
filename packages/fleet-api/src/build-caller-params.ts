import { match } from 'ts-pattern';

// The params a procedure sends its caller: what the input schema parsed, and the guards that the
// MCP tools have always set for the procedure.
export function buildCallerParams(
  method: string,
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return match(method)
    .with('session.kill', () => ({ ...input, stopOnly: true }))
    .with('session.forget', () => {
      const { stop, ...rest } = input;

      return { ...rest, refusePinned: true, refuseLive: stop !== true };
    })
    .with('session.spawn', 'session.adopt', () => ({ ...input, cols: 100, rows: 30 }))
    .otherwise(() => input);
}
