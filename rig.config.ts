import { defineRig } from '@zgeoff/rig';

export default defineRig({
  ignore: ['mods/**', 'e2e/**'],
  lanes: {
    codex: { limit: '5s' },
    toolchain: { limit: '15s' },
  },
});
