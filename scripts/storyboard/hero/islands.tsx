import { BackgroundCube } from './background-cube.tsx';
import { Beacon } from './beacon.tsx';
import { Flash } from './flash.tsx';
import { Island } from './island.tsx';
import { BUILDER_API, GATEWAY, IMPZ, LAPTOP, ORCHESTRATOR } from './layout.ts';
import { NamedCube } from './named-cube.tsx';
import { Ripple } from './ripple.tsx';
import { SpritesIsland } from './sprites-island.tsx';
import { buildCrouch, buildPop } from './squash.tsx';
import { times } from './times.ts';
import { Tower } from './tower.tsx';

// The four islands and what stands on them: the gateway with its tower in the middle, and the
// laptop, the microVMs and the sprites round it.
export function Islands() {
  return (
    <>
      <Island
        x={GATEWAY.x}
        y={GATEWAY.y}
        width={GATEWAY.width}
        depth={22}
        title="GATEWAY"
        subtitle="atc gateway"
        shard={36}
        bob={[5, 2]}
      >
        <Tower />
        <Beacon />
      </Island>
      <Island
        x={LAPTOP.x}
        y={LAPTOP.y}
        width={LAPTOP.width}
        depth={22}
        title="LAPTOP"
        subtitle="atc daemon"
        shard={40}
        bob={[6, 3]}
      >
        <BackgroundCube x={LAPTOP.x - 45} y={LAPTOP.y + 19} kind="codex" state="idle" seed={0.4} />
        <BackgroundCube
          x={LAPTOP.x + 45}
          y={LAPTOP.y + 21}
          kind="grok"
          state="code"
          seed={1.1}
          flicker={[2.6, 1.3]}
        />
        <NamedCube
          x={ORCHESTRATOR.x}
          y={ORCHESTRATOR.y}
          kind="claude"
          faces={[
            { state: 'code', windows: [[undefined, times.typed]] },
            { state: 'think', windows: [[times.sent, times.reply]] },
            { state: 'idle', windows: [[times.typed, times.sent]] },
            { state: 'code', windows: [[times.reply, undefined]] },
          ]}
          squashes={[buildPop(times.sent, 0.5, true), buildCrouch(times.spawnLift)]}
        />
      </Island>
      <Island
        x={IMPZ.x}
        y={IMPZ.y}
        width={IMPZ.width}
        depth={22}
        title="IMPZ"
        subtitle="microVMs"
        shard={36}
        bob={[7, 2.5]}
      >
        <BackgroundCube
          x={IMPZ.x - 50}
          y={IMPZ.y + 8}
          kind="grok"
          state="code"
          seed={0.8}
          flicker={[2.2, 0.8]}
        />
        <BackgroundCube x={IMPZ.x + 48} y={IMPZ.y + 10} kind="claude" state="idle" seed={1.7} />
        <Ripple
          x={BUILDER_API.x}
          y={BUILDER_API.y}
          when={times.askLanded}
          tone="blue"
          radius={52}
        />
        <NamedCube
          x={BUILDER_API.x}
          y={BUILDER_API.y}
          kind="codex"
          seed={0.3}
          faces={[
            { state: 'code', windows: [[undefined, times.askLanded]] },
            { state: 'think', windows: [[times.askLanded, times.answerLine]] },
            { state: 'code', windows: [[times.answerLine, undefined]] },
          ]}
          squashes={[buildPop(times.askLanded, 1, true), buildCrouch(times.answerLift, 0.015)]}
        />
        <BackgroundCube x={IMPZ.x - 12} y={IMPZ.y + 30} kind="codex" state="idle" seed={2.4} />
        <Flash
          x={BUILDER_API.x}
          y={BUILDER_API.y - 18}
          when={times.askLanded}
          tone="blue"
          radius={30}
        />
      </Island>
      <SpritesIsland />
    </>
  );
}
