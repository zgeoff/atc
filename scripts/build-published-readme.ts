import { posix } from 'node:path';

// npm ships the README without the repository around it, so each relative link
// becomes a link into the repository at the release that publishes the package.
export function buildPublishedReadme(markdown: string, treeURL: string, directory: string): string {
  return markdown.replaceAll(/\]\((?<target>(?![a-z]+:|#)[^)\s]+)\)/gu, (whole, target: string) => {
    const path = posix.normalize(posix.join(directory, target));

    return path.startsWith('../') ? whole : `](${treeURL}/${path})`;
  });
}
