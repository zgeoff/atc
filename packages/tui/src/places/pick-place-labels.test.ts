import { expect, test } from 'bun:test';
import { pickPlaceLabels } from './pick-place-labels';

test.each([
  {
    title: 'the one label of a place on one daemon',
    sessions: [{ daemon: 'lab', target: 'box', place: { key: 'k1', label: 'cloud' } }],
    order: ['lab'],
    expected: [['k1', 'cloud']],
  },
  {
    title: 'the label of the daemon on this computer over the others',
    sessions: [
      { daemon: 'lab', target: 'box', place: { key: 'k1', label: 'cloud' } },
      { daemon: null, target: 'box', place: { key: 'k1', label: 'cloud' } },
    ],
    order: ['lab'],
    expected: [['k1', 'cloud']],
  },
  {
    title: 'the label of the daemon listed first when none is local',
    sessions: [
      { daemon: 'box', target: 'box', place: { key: 'k1', label: 'second' } },
      { daemon: 'lab', target: 'box', place: { key: 'k1', label: 'first' } },
    ],
    order: ['lab', 'box'],
    expected: [['k1', 'first']],
  },
  {
    title: 'the daemon name on two places with one label',
    sessions: [
      { daemon: 'lab', target: 'box', place: { key: 'k1', label: 'docker' } },
      { daemon: 'box', target: 'box', place: { key: 'k2', label: 'docker' } },
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
      { daemon: null, target: 'box', place: { key: 'k1', label: 'docker' } },
      { daemon: 'box', target: 'box', place: { key: 'k2', label: 'docker' } },
    ],
    order: ['box'],
    expected: [
      ['k1', 'docker · local'],
      ['k2', 'docker · box'],
    ],
  },
  {
    title: 'the target id on two places with one label on one daemon',
    sessions: [
      { daemon: 'lab', target: 'east', place: { key: 'k1', label: 'box' } },
      { daemon: 'lab', target: 'west', place: { key: 'k2', label: 'box' } },
    ],
    order: ['lab'],
    expected: [
      ['k1', 'box · lab · east'],
      ['k2', 'box · lab · west'],
    ],
  },
  {
    title: 'the place key on two places with one label on one target',
    sessions: [
      { daemon: 'lab', target: 'vm', place: { key: 'k1', label: 'vm' } },
      { daemon: 'lab', target: 'vm', place: { key: 'k2', label: 'vm' } },
    ],
    order: ['lab'],
    expected: [
      ['k1', 'vm · lab · k1'],
      ['k2', 'vm · lab · k2'],
    ],
  },
  {
    title: 'distinct labels when a qualified label matches another place of its own',
    sessions: [
      { daemon: 'lab', target: 'vm', place: { key: 'k1', label: 'cloud' } },
      { daemon: 'box', target: 'vm', place: { key: 'k2', label: 'cloud' } },
      { daemon: 'lab', target: 'vm', place: { key: 'k3', label: 'cloud · lab' } },
    ],
    order: ['lab', 'box'],
    expected: [
      ['k1', 'cloud · lab · vm'],
      ['k2', 'cloud · box'],
      ['k3', 'cloud · lab · lab'],
    ],
  },
])('#pickPlaceLabels gives $title', (row) => {
  expect([...pickPlaceLabels(row.sessions, row.order)]).toStrictEqual(
    row.expected.map(([key, label]) => [key, label]),
  );
});
