import { basename } from 'node:path';
import { sortSessionViews } from '@atc/protocol';
import type { DaemonName, SessionKey } from '../fleet/session-key';
import type { MirrorSession } from '../fleet/to-mirror-session';
import { pickDistinctLabels } from '../places/pick-distinct-labels';
import { pickPlaceLabels } from '../places/pick-place-labels';
import { toDaemonLabel } from '../places/to-session-place';
import { findFuzzyScore, formatDir } from '../terminal/pick-matches';
import type { Grouping, ListRow } from './types';

export interface ListRowOptions {
  readonly grouping: Grouping;
  readonly filter: string | null;

  // the config's daemons in order, which settles a place's label when daemons disagree
  readonly daemons: readonly DaemonName[];
}

// The rows of the session list: sessions as `sortSessionViews` orders them, in flat order or under
// a header for each repository or place, with pinned sessions in a group above the rest.
export function collectListRows(
  sessions: readonly MirrorSession[],
  options: ListRowOptions,
): ListRow[] {
  const sorted = sortAcrossDaemons(filterSessions(sessions, options.filter));

  if (options.grouping === 'flat') {
    return sorted.map((session) => ({ kind: 'session', session, via: null }));
  }

  return collectGroups(sorted, options).flatMap((group) => toGroupRows(group, options.grouping));
}

// Two daemons can hold one session id, so the sort sees each id with its daemon in front.
function sortAcrossDaemons(sessions: readonly MirrorSession[]): MirrorSession[] {
  const byNamespace = new Map(sessions.map((session) => [toNamespacedID(session), session]));

  const namespaced = sessions.map((session) => ({
    ...session,
    id: toNamespacedID(session),
    parent: session.parent === null ? null : toNamespacedID({ ...session, id: session.parent }),
  }));

  return sortSessionViews(namespaced).flatMap((view) => byNamespace.get(view.id) ?? []);
}

function toNamespacedID(session: SessionKey): string {
  return `${session.daemon ?? ''}\n${session.id}`;
}

// A row matches on its name and directory. A parent stays while a child of it matches.
function filterSessions(
  sessions: readonly MirrorSession[],
  filter: string | null,
): MirrorSession[] {
  if (filter === null || filter === '') {
    return [...sessions];
  }

  const matched = new Set(
    sessions
      .filter(
        (session) => findFuzzyScore(`${session.name} ${formatDir(session.cwd)}`, filter) !== null,
      )
      .map((session) => toNamespacedID(session)),
  );

  return sessions.filter(
    (session) =>
      matched.has(toNamespacedID(session)) ||
      sessions.some((child) => isChildOf(child, session) && matched.has(toNamespacedID(child))),
  );
}

function isChildOf(child: MirrorSession, parent: MirrorSession): boolean {
  return child.parent === parent.id && child.daemon === parent.daemon;
}

interface Group {
  readonly key: string;
  readonly label: string;
  readonly isPinned: boolean;
  readonly sessions: MirrorSession[];
}

const PINNED_LABEL = 'pinned';

function collectGroups(sorted: readonly MirrorSession[], options: ListRowOptions): Group[] {
  const placeLabels = pickPlaceLabels(sorted, options.daemons);
  const repoLabels = pickRepoLabels(sorted);

  const groups = new Map<string, Group>();

  // the session at the top of each family; the sort puts a parent before its sub-sessions
  const owners = new Map<string, MirrorSession>();

  for (const session of sorted) {
    const owner =
      (session.parent === null
        ? undefined
        : owners.get(toNamespacedID({ ...session, id: session.parent }))) ?? session;

    owners.set(toNamespacedID(session), owner);

    const group = owner.pinned
      ? { key: PINNED_LABEL, label: PINNED_LABEL, isPinned: true }
      : pickGroup(owner, options.grouping, placeLabels, repoLabels);

    const held = groups.get(group.key);

    if (held === undefined) {
      groups.set(group.key, { ...group, sessions: [session] });
    } else {
      held.sessions.push(session);
    }
  }

  return orderGroups([...groups.values()]);
}

// A repo group is one daemon's sessions in one repo root, labelled by the root's folder name. Two
// groups with one folder name add the daemon's name, then the folders above the root, nearest
// first, then the whole root, until they differ.
function pickRepoLabels(sessions: readonly MirrorSession[]): ReadonlyMap<string, string> {
  const roots = new Map<string, MirrorSession>();

  for (const session of sessions) {
    roots.set(toRepoKey(session), session);
  }

  const keys = [...roots.keys()];

  const labels = pickDistinctLabels(
    [...roots.values()].map((session) => {
      const folders = session.repoRoot.split('/').filter((folder) => folder !== '');

      return {
        label: basename(session.repoRoot),
        qualifiers: [
          toDaemonLabel(session.daemon),
          ...folders.slice(0, -1).toReversed(),
          session.repoRoot,
        ],
      };
    }),
  );

  return new Map(keys.map((key, index) => [key, labels[index] ?? key]));
}

function toRepoKey(session: MirrorSession): string {
  return `${session.daemon ?? ''}\n${session.repoRoot}`;
}

function pickGroup(
  owner: MirrorSession,
  grouping: Grouping,
  placeLabels: ReadonlyMap<string, string>,
  repoLabels: ReadonlyMap<string, string>,
): Omit<Group, 'sessions'> {
  if (grouping === 'place') {
    return {
      key: `place:${owner.place.key}`,
      label: placeLabels.get(owner.place.key) ?? owner.place.label,
      isPinned: false,
    };
  }

  const key = toRepoKey(owner);

  return {
    key: `repo:${key}`,
    label: repoLabels.get(key) ?? basename(owner.repoRoot),
    isPinned: false,
  };
}

// The pinned group comes first. The others go by their first session, then by label.
function orderGroups(groups: readonly Group[]): Group[] {
  const pinned = groups.filter((group) => group.isPinned);

  const others = groups
    .filter((group) => !group.isPinned)
    .toSorted((left, right) => left.label.localeCompare(right.label));

  const ranked = sortSessionViews(
    others.flatMap((group) => {
      const [first] = group.sessions;

      return first === undefined ? [] : [{ ...first, id: group.key, parent: null }];
    }),
  );

  return [...pinned, ...ranked.flatMap((view) => others.filter((group) => group.key === view.id))];
}

function toGroupRows(group: Group, grouping: Grouping): ListRow[] {
  const daemons = new Set(group.sessions.map((session) => session.daemon));

  const isMixed = grouping === 'place' && daemons.size > 1;

  return [
    {
      kind: 'header',
      label: group.label,
      count: group.sessions.length,
      needYou: group.sessions.filter((session) => session.state === 'needs_you').length,
    },
    ...group.sessions.map((session): ListRow => ({
      kind: 'session',
      session,
      via: isMixed ? toDaemonLabel(session.daemon) : null,
    })),
  ];
}
