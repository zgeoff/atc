// Claude, Codex and Grok all read hooks in this shape; `timeout` is seconds.
export interface HookEntry {
  readonly hooks: readonly [
    { readonly type: 'command'; readonly command: string; readonly timeout: number },
  ];
}

export function buildHookEntry(command: string, timeout: number): HookEntry {
  return { hooks: [{ type: 'command', command, timeout }] };
}
