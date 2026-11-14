import { runVerify } from '@wringer/gunshi';
import { createVerifyRegistry } from './create-verify-registry.ts';

// The repo's verify CLI. The root `verify` script runs this file, so an agent calls
// `bun verify <command>`. `skill` names the folder of the repo's verify skill, which `lint` checks.
await runVerify(createVerifyRegistry(), { skill: '.claude/skills/verify' });
