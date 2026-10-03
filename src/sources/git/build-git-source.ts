import { isGitURL } from '../../shared/is-git-url';
import type { SourceInterpretation, SourceProvider } from '../types';

/**
 * A git repository at a typed URL, which needs nothing installed beyond
 * git. It lists nothing; typed input is a repository when it is a URL git
 * reads.
 */
export function buildGitSource(): SourceProvider {
  return {
    id: 'git',
    label: 'git URL',
    kind: 'git',
    list: () => Promise.resolve({ candidates: [], scope: null }),
    interpret(input) {
      const url = input.trim();

      const interpretation: SourceInterpretation = isGitURL(url)
        ? { kind: 'git', url }
        : { kind: 'none' };

      return Promise.resolve(interpretation);
    },
  };
}
