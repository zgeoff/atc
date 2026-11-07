import { defineRig } from '@zgeoff/rig';

export default defineRig({
  // bunfig.toml's test section gives the reason for each folder
  ignore: ['mods/**', 'e2e/**'],
  lanes: {
    codex: { limit: '5s' },
    toolchain: { limit: '15s' },
  },
});
