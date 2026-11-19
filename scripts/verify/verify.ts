import { runVerify } from '@wringer/gunshi';
import { createVerifyRegistry } from './create-verify-registry.ts';

await runVerify(createVerifyRegistry(), { skill: '.agents/skills/verify' });
