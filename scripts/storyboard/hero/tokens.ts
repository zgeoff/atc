import { defineTokens } from '@zgeoff/storyboard';

const claude = ['#b4f6e0', '#4cc9a2', '#2d8f72'] as const;
const codex = ['#d3dcff', '#869cf2', '#5568c4'] as const;
const grok = ['#eef0f6', '#b4bbcf', '#7b8399'] as const;

export default defineTokens({
  claudeTop: claude[0],
  claudeLeft: claude[1],
  claudeRight: claude[2],
  claudeTopDim: mixHex(claude[0], 0.22),
  claudeLeftDim: mixHex(claude[1], 0.22),
  claudeRightDim: mixHex(claude[2], 0.22),
  claudeTopIdle: mixHex(claude[0], 0.5),
  claudeLeftIdle: mixHex(claude[1], 0.5),
  claudeRightIdle: mixHex(claude[2], 0.5),
  claudeMarkIdle: mixHex(mixHex(claude[2], 0.5), 0.3),
  codexTop: codex[0],
  codexLeft: codex[1],
  codexRight: codex[2],
  codexTopDim: mixHex(codex[0], 0.22),
  codexLeftDim: mixHex(codex[1], 0.22),
  codexRightDim: mixHex(codex[2], 0.22),
  codexTopIdle: mixHex(codex[0], 0.5),
  codexLeftIdle: mixHex(codex[1], 0.5),
  codexRightIdle: mixHex(codex[2], 0.5),
  codexMarkIdle: mixHex(mixHex(codex[2], 0.5), 0.3),
  grokTop: grok[0],
  grokLeft: grok[1],
  grokRight: grok[2],
  grokTopDim: mixHex(grok[0], 0.22),
  grokLeftDim: mixHex(grok[1], 0.22),
  grokRightDim: mixHex(grok[2], 0.22),
  grokTopIdle: mixHex(grok[0], 0.5),
  grokLeftIdle: mixHex(grok[1], 0.5),
  grokRightIdle: mixHex(grok[2], 0.5),
  grokMarkIdle: mixHex(mixHex(grok[2], 0.5), 0.3),
  white: '#ffffff',
  faint: '#56628a',
  slateTop: '#46548a',
  slateTopEnd: '#2c365e',
  slateLeft: '#2a3358',
  slateRight: '#1d2444',
  shardLeft: '#1a1f36',
  shardRight: '#11152a',
  shardGlint: '#262c4b',
  screen: '#0d1424',
  screenAlert: '#fff3d6',
  amberTop: '#ffe0a3',
  amberLeft: '#f5a948',
  amberRight: '#c57a22',
  star: '#c9d4ff',
  haze: '#7f8cff',
  nebula: '#3d4d8f',
  skyCenter: '#1c2448',
  skyMiddle: '#111631',
  skyEdge: '#080a17',
  ground: '#05070f',
  panel: '#0f1426',
  bubble: '#1b2340',
  link: '#8f9bbb',
  towerLightTop: '#d9def0',
  towerLightLeft: '#a3abc6',
  towerLightRight: '#6c7594',
  stoneTop: '#c3c9de',
  stoneLeft: '#7d86a8',
  stoneRight: '#535c7e',
  glassTop: '#d9def0',
  glassLeft: '#14304a',
  glassRight: '#0c2236',
  roofTop: '#e3e9f7',
  roofLeft: '#8e97b8',
  roofRight: '#5d6688',
  mast: '#c9cfe6',
  trailCore: '#eef1ff',
  beaconTop: '#b4f6e0',
  beaconGlint: '#e9fff7',
  beaconRight: '#2d8f72',
  beaconLeft: '#4cc9a2',
});

// A colour mixed toward the night: a background agent's cube is a little dim, and an idle one more.
function mixHex(color: string, share: number): string {
  const night = '#10142a';

  const mixed = [1, 3, 5].map((index) => {
    const from = Number.parseInt(color.slice(index, index + 2), 16);
    const to = Number.parseInt(night.slice(index, index + 2), 16);

    return Math.round(from * (1 - share) + to * share)
      .toString(16)
      .padStart(2, '0');
  });

  return `#${mixed.join('')}`;
}
