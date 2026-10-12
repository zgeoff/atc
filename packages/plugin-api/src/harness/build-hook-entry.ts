/**
 * One hook event's entry in a harness's hooks block: a single command that
 * the harness runs on the event and stops after `timeout` seconds. Claude,
 * Codex and Grok all read hooks in this shape.
 */
export interface HookEntry {
  readonly hooks: readonly [
    { readonly type: 'command'; readonly command: string; readonly timeout: number },
  ];
}

/**
 * The hooks-block entry that runs `command` on one hook event, stopped
 * after `timeout` seconds.
 */
export function buildHookEntry(command: string, timeout: number): HookEntry {
  return { hooks: [{ type: 'command', command, timeout }] };
}
