import { defineRig } from '@zgeoff/rig';

export default defineRig({
  lanes: {
    codex: { limit: '5s' },
    toolchain: { limit: '15s' },
  },
});
