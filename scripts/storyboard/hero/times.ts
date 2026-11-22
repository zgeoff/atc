import { FADE_S } from './constants.ts';
import { buildWhen } from './when.ts';

const FLIGHT_S = 0.75;

// The instants of the loop that the drawings follow, named for the change that makes each one. The
// ids are the ones that scene.tsx gives its changes.
export const times = {
  typed: buildWhen('prompt.typed'),
  sent: buildWhen('prompt.sent'),
  reply: buildWhen('reply'),
  spawnLine: buildWhen('spawnLine'),
  spawnLift: buildWhen('spawnLanded', -FLIGHT_S),
  spawnGrow: buildWhen('spawnLanded', -FLIGHT_S - FADE_S),
  spawnLanded: buildWhen('spawnLanded'),
  uiLine: buildWhen('uiLine'),
  eventPassed: buildWhen('ev1.stop2'),
  eventLanded: buildWhen('ev1'),
  askLine: buildWhen('askLine'),
  askLift: buildWhen('askLanded', -FLIGHT_S),
  askLanded: buildWhen('askLanded'),
  answerLine: buildWhen('answerLine'),
  answerLift: buildWhen('answerLanded', -FLIGHT_S),
  answerLanded: buildWhen('answerLanded'),
  need: buildWhen('need'),
  hop: buildWhen('need', 0.39),
  needPassed: buildWhen('needLanded.stop2'),
  needLanded: buildWhen('needLanded'),
  clear: buildWhen('clear'),
  cleared: buildWhen('cleared'),
  clearedPassed: buildWhen('cleared.stop2'),
  deploy: buildWhen('deploy'),
  result: buildWhen('result'),
  resultPassed: buildWhen('ev3.stop2'),
  resultLanded: buildWhen('ev3'),
  reset: buildWhen('reset'),
};
