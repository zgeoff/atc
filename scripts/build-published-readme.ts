import { posix } from 'node:path';

// npm ships the README without the repository around it, so each relative link
// becomes a link into the repository at the release that publishes the package.
export function buildPublishedReadme(markdown: string, treeURL: string, directory: string): string {
  const toRepositoryLink = (whole: string, target: string): string => {
    const path = posix.normalize(posix.join(directory, target));

    return path.startsWith('../') ? whole : whole.replace(target, `${treeURL}/${path}`);
  };

  return markdown
    .replaceAll(/\]\((?<target>(?![a-z]+:|#)[^)\s]+)\)/gu, toRepositoryLink)
    .replaceAll(/href="(?<target>(?![a-z]+:|#)[^"]+)"/gu, toRepositoryLink);
}
