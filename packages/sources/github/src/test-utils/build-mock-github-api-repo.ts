import { faker } from '@faker-js/faker';

// A repository as GitHub's REST API returns it, in the fields a listing reads.
interface GitHubAPIRepo {
  readonly full_name: string;
  readonly description: string | null;
  readonly private: boolean;
  readonly html_url: string;
  readonly ssh_url: string;
}

export function buildMockGitHubAPIRepo(overrides: Partial<GitHubAPIRepo> = {}): GitHubAPIRepo {
  const fullName =
    overrides.full_name ?? `${faker.internet.username()}/${faker.string.alphanumeric(8)}`;

  return {
    full_name: fullName,
    description: faker.lorem.sentence(),
    private: faker.datatype.boolean(),
    html_url: `https://github.com/${fullName}`,
    ssh_url: `git@github.com:${fullName}.git`,
    ...overrides,
  };
}
