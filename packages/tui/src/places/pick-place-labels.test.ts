import { expect, test } from 'bun:test';
import { pickPlaceLabels } from './pick-place-labels';

test.each([
  {
    title: 'the one label of a place on one daemon',
    sessions: [{ daemon: 'lab', place: { key: 'k1', label: 'cloud' } }],
    order: ['lab'],
    expected: [['k1', 'cloud']],
  },
  {
    title: 'the label of the daemon on this computer over the others',
    sessions: [
      { daemon: 'lab', place: { key: 'k1', label: 'cloud' } },
      { daemon: null, place: { key: 'k1', label: 'cloud' } },
    ],
    order: ['lab'],
    expected: [['k1', 'cloud']],
  },
  {
    title: 'the label of the daemon listed first when none is local',
    sessions: [
      { daemon: 'box', place: { key: 'k1', label: 'second' } },
      { daemon: 'lab', place: { key: 'k1', label: 'first' } },
    ],
    order: ['lab', 'box'],
    expected: [['k1', 'first']],
  },
  {
    title: 'the daemon name on two places with one label',
    sessions: [
      { daemon: 'lab', place: { key: 'k1', label: 'docker' } },
      { daemon: 'box', place: { key: 'k2', label: 'docker' } },
    ],
    order: ['lab', 'box'],
    expected: [
      ['k1', 'docker · lab'],
      ['k2', 'docker · box'],
    ],
  },
  {
    title: 'local as the daemon name of the daemon on this computer',
    sessions: [
      { daemon: null, place: { key: 'k1', label: 'docker' } },
      { daemon: 'box', place: { key: 'k2', label: 'docker' } },
    ],
    order: ['box'],
    expected: [
      ['k1', 'docker · local'],
      ['k2', 'docker · box'],
    ],
  },
])('#pickPlaceLabels gives $title', (row) => {
  expect([...pickPlaceLabels(row.sessions, row.order)]).toStrictEqual(
    row.expected.map(([key, label]) => [key, label]),
  );
});
