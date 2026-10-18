// Fails on the owner's domain, home path, or a vault outside the invented ones
// in a tracked file. The domain and the login stay public only as SHA-256
// hashes, and a finding names the file and the line, never the matched text.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const hashes = loadHashes(process.argv[3] ?? join(import.meta.dir, 'owner-name-hashes.json'));

  const files = await collectTrackedFiles(root);

  const found = files.flatMap((file) =>
    collectOwnerNames(readFileSync(join(root, file), 'utf8'), hashes).map(
      (finding) => `${finding.kind}: ${file}:${finding.line}`,
    ),
  );

  for (const finding of found) {
    console.error(finding);
  }

  console.log(`check-owner-names: ${found.length} owner names`);

  if (found.length > 0) {
    process.exit(1);
  }
}

interface OwnerNameHashes {
  domains: Set<string>;
  logins: Set<string>;
}

function loadHashes(file: string): OwnerNameHashes {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { domains: string[]; logins: string[] };

  return { domains: new Set(parsed.domains), logins: new Set(parsed.logins) };
}

// The check's own test, whose probes are invented names that it must find.
const ALLOWED_FILES = new Set(['scripts/check-owner-names.test.ts']);

async function collectTrackedFiles(root: string): Promise<string[]> {
  const listed = Bun.spawn(['git', 'ls-files', '-z'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(listed.stdout).text(),
    new Response(listed.stderr).text(),
    listed.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`git ls-files failed in ${root}: ${stderr}`);
  }

  return stdout
    .split('\0')
    .filter((file) => file !== '' && !ALLOWED_FILES.has(file) && existsSync(join(root, file)))
    .filter((file) => !readFileSync(join(root, file)).includes(0));
}

interface OwnerName {
  kind: string;
  line: number;
}

// Invented vault names, and a placeholder that starts with one of these
// characters, such as `<vault>` or `${VAULT}`.
const ALLOWED_VAULTS = new Set(['example', 'vault']);

const PLACEHOLDER_STARTS = ['<', '$', '{'];
const HOST = /(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*/giu;
const HOME = /\/(?:home|Users)\/(?<login>[^/\s'"`]+)/gu;
const VAULT = /op:\/\/(?<vault>[^/\s'"`]+)\//gu;

function collectOwnerNames(source: string, hashes: OwnerNameHashes): OwnerName[] {
  return source.split('\n').flatMap((text, index) => {
    const line = index + 1;
    const names: OwnerName[] = [];

    if ([...text.matchAll(HOST)].some((match) => isOwnerHost(match[0], hashes.domains))) {
      names.push({ kind: 'owner domain', line });
    }

    if (
      [...text.matchAll(HOME)].some((match) =>
        hashes.logins.has(buildDigest(match.groups?.['login'] ?? '')),
      )
    ) {
      names.push({ kind: 'owner home path', line });
    }

    if ([...text.matchAll(VAULT)].some((match) => !isAllowedVault(match.groups?.['vault'] ?? ''))) {
      names.push({ kind: 'vault outside the allow list', line });
    }

    return names;
  });
}

// A host is the owner's when it, or a parent domain of it, hashes to one of
// the owner's domains.
function isOwnerHost(host: string, domains: Set<string>): boolean {
  const labels = host.toLowerCase().split('.');

  return labels.some(
    (_, start) =>
      labels.length - start >= 2 && domains.has(buildDigest(labels.slice(start).join('.'))),
  );
}

function isAllowedVault(vault: string): boolean {
  return ALLOWED_VAULTS.has(vault) || PLACEHOLDER_STARTS.some((start) => vault.startsWith(start));
}

function buildDigest(name: string): string {
  return createHash('sha256').update(name).digest('hex');
}

await main();
