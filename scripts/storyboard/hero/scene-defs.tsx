import { Def, getColor, getID } from './kit.ts';

// The gradients and blurs that the drawings share.
export function SceneDefs() {
  return (
    <>
      <Def>
        <radialGradient id={getID('sky')} cx={0.5} cy={0.5} r={0.8}>
          <stop offset={0} stop-color={getColor('skyCenter')} />
          <stop offset={0.55} stop-color={getColor('skyMiddle')} />
          <stop offset={1} stop-color={getColor('skyEdge')} />
        </radialGradient>
      </Def>
      <Def>
        <radialGradient id={getID('nebula')} cx={0.5} cy={0.5} r={0.5}>
          <stop offset={0} stop-color={getColor('nebula')} stop-opacity={0.26} />
          <stop offset={1} stop-color={getColor('nebula')} stop-opacity={0} />
        </radialGradient>
      </Def>
      <Def>
        <radialGradient id={getID('haze')} cx={0.5} cy={0.5} r={0.5}>
          <stop offset={0} stop-color={getColor('haze')} stop-opacity={0.35} />
          <stop offset={1} stop-color={getColor('haze')} stop-opacity={0} />
        </radialGradient>
      </Def>
      <Def>
        <linearGradient id={getID('slateTop')} x1={0} y1={0} x2={1} y2={1}>
          <stop offset={0} stop-color={getColor('slateTop')} />
          <stop offset={1} stop-color={getColor('slateTopEnd')} />
        </linearGradient>
      </Def>
      <Def>
        <filter id={getID('soft')} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={5} />
        </filter>
      </Def>
      <Def>
        <filter id={getID('soft2')} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation={1.6} />
        </filter>
      </Def>
    </>
  );
}
