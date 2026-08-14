# Changelog

## [0.1.5](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.4...@zgeoff/atc@0.1.5) (2026-08-14)

### Features

- gate fleet restore on each session's SessionStart hook
  ([#14](https://github.com/zgeoff/atc/issues/14))
  ([ad37010](https://github.com/zgeoff/atc/commit/ad370101a4bd69b492a81e3b1e8a8d970e0d5f13))

## [0.1.4](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.3...@zgeoff/atc@0.1.4) (2026-08-13)

### Bug Fixes

- cluster overlay rows by group so headers render once per group
  ([#12](https://github.com/zgeoff/atc/issues/12))
  ([2e9a400](https://github.com/zgeoff/atc/commit/2e9a4001fceeb50d4a71b124fdda801b23de3f5a))

## [0.1.3](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.2...@zgeoff/atc@0.1.3) (2026-08-13)

### Features

- keep a stale daemon in service until a deliberate restart
  ([#10](https://github.com/zgeoff/atc/issues/10))
  ([37f5768](https://github.com/zgeoff/atc/commit/37f57682ea877646071ec4a1339aa27657859cba))

## [0.1.2](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.1...@zgeoff/atc@0.1.2) (2026-08-13)

### Features

- group sessions and let agents organise the fleet ([#8](https://github.com/zgeoff/atc/issues/8))
  ([ae870d7](https://github.com/zgeoff/atc/commit/ae870d783583d5fd577e472221ce302aea8d21b4))
- scale the overlay for large fleets ([#7](https://github.com/zgeoff/atc/issues/7))
  ([d2917ee](https://github.com/zgeoff/atc/commit/d2917ee4b13f9a489a0818bc68a2805d905d1ea0))

## [0.1.1](https://github.com/zgeoff/atc/compare/@zgeoff/atc@0.1.0...@zgeoff/atc@0.1.1) (2026-08-12)

### Features

- add an on-demand fleet brief
  ([ffe281b](https://github.com/zgeoff/atc/commit/ffe281bb1cb1f189678db4186393516c9ba99b47))
- add the daemon protocol listener with handshake and dispatch
  ([d8d2323](https://github.com/zgeoff/atc/commit/d8d23236963a551ff4cf373b5d61165cc88e092a))
- add the screen tier of the attention detector stack
  ([1021b40](https://github.com/zgeoff/atc/commit/1021b4079355a34b511c97123eca2b820bb077ee))
- add the wire protocol codec and per-client outbound queue
  ([91ae5be](https://github.com/zgeoff/atc/commit/91ae5be172250439dc6440dce96a4504490ab50e))
- adopt citty for cli dispatch
  ([15721dc](https://github.com/zgeoff/atc/commit/15721dcfcf75a3a8236a3edf7872565116863544))
- arbitrate permission requests first-response-wins
  ([39cf6d3](https://github.com/zgeoff/atc/commit/39cf6d377439611c2ecf024692b52e85d6813484))
- expose the fleet as mcp tools
  ([a96d109](https://github.com/zgeoff/atc/commit/a96d1095a6de7fec40ca004fa8f17a8eebcc560b))
- hand sessions off between terminal and headless
  ([d79d6f0](https://github.com/zgeoff/atc/commit/d79d6f08ff2fc00c1677a24fbc608a714149bc2a))
- initial atc MVP
  ([83e11e1](https://github.com/zgeoff/atc/commit/83e11e1b1aa9935f2c225ed86b6336722ee9c98e))
- keep daemon state in sqlite
  ([5747cd8](https://github.com/zgeoff/atc/commit/5747cd840588556682eedde4ec3492c3d996b15e))
- make the overlay leader key configurable ([#6](https://github.com/zgeoff/atc/issues/6))
  ([4c67b53](https://github.com/zgeoff/atc/commit/4c67b5339542031d87bf5f595166f20731e6cb59))
- make the tui a thin client that auto-spawns the daemon
  ([6cccb8f](https://github.com/zgeoff/atc/commit/6cccb8fd57666b1a1dc1bab613da65f067d2752a))
- move session ownership into the daemon
  ([3872e54](https://github.com/zgeoff/atc/commit/3872e544395d0156a8b749e201a26d38acdddb46))
- overlay slash filter and attach-clears-need
  ([224cf34](https://github.com/zgeoff/atc/commit/224cf34b42289d482413d7c9340eeb9a162ccdb9))
- preselect the focused session when the overlay opens
  ([d16631f](https://github.com/zgeoff/atc/commit/d16631f977be7cbe8c372fc7ea474c3d6b01781e))
- publish to npm as @zgeoff/atc via release-please ([#2](https://github.com/zgeoff/atc/issues/2))
  ([9e9ed07](https://github.com/zgeoff/atc/commit/9e9ed07e28fd9839a3ea0714397e8f8e0df6f3d3))
- pull session names from claude transcripts
  ([106c8fd](https://github.com/zgeoff/atc/commit/106c8fdcb050b6e328828484046fa861e1b161fd))
- remove the fleet brief
  ([048fbcc](https://github.com/zgeoff/atc/commit/048fbcc235d0421b3cb880a6d0583ad4caa267b8))
- replace the attach jiggle with a headless screen model
  ([7e78d94](https://github.com/zgeoff/atc/commit/7e78d941dfc71adbde318f6b5f43b8fc69a9730d))
- revive a killed session from the overlay
  ([ea40c1d](https://github.com/zgeoff/atc/commit/ea40c1d5cfacd721e3deb5deeeaf8c5770ff85ec))
- show only the selected session's actions in the overlay hints
  ([bd53ca3](https://github.com/zgeoff/atc/commit/bd53ca39d05879a827277965b52068b1b0e709eb))
- stream sessions to attached clients with input and resize
  ([5d4b948](https://github.com/zgeoff/atc/commit/5d4b9480e426425cffd6e831ae94e5246a859faf))

### Bug Fixes

- carry alive and kind on session.state so the client stops guessing
  ([d7db6e9](https://github.com/zgeoff/atc/commit/d7db6e9eda53770276ba0977d19619f3d04098fd))
- guard revive and eject on a saved transcript and surface failures
  ([c15d6f3](https://github.com/zgeoff/atc/commit/c15d6f3af604384a2066306f6ad2d235fd9b0365))
- harden the mcp test client against short writes and any leaks
  ([882c473](https://github.com/zgeoff/atc/commit/882c4737b87fbde7021234c4b703dfa8122fce9c))
- keep spawned claudes out of any enclosing claude session
  ([e5ae5cb](https://github.com/zgeoff/atc/commit/e5ae5cb6eb2e777b6909088c6005873ff3e29dc2))
- move the daemon pid file beside its sockets, compare fresh builds
  ([72cd37c](https://github.com/zgeoff/atc/commit/72cd37cdf246dd1b7d8c065321182e433d2047aa))
- point release automation at the componentful release-please branch
  ([#4](https://github.com/zgeoff/atc/issues/4))
  ([512466d](https://github.com/zgeoff/atc/commit/512466d2471561fd57689814a0c60f149fdad7f8))
- restart a daemon left running from an older build
  ([355dc64](https://github.com/zgeoff/atc/commit/355dc64187eaa3f536cf113ce7e5fff5e2cf9ef7))
- stamp the build identity with the entry file mtime
  ([ed1ba7c](https://github.com/zgeoff/atc/commit/ed1ba7cb17d28821ee81c3e11f952d8a99a9e09d))
- stamp the build with the newest source mtime, not one entry file
  ([b24786f](https://github.com/zgeoff/atc/commit/b24786fcdb5ba8fc0118f40f0b262d6c0ab779bd))
- stateful decode on the stdin to pty path
  ([9465854](https://github.com/zgeoff/atc/commit/9465854933c33780a825857511eab9dc57556171))
