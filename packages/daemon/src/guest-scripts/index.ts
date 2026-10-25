import { READ_PROJECT_SETTINGS_SCRIPT } from '../auth/read-project-settings-script';
import {
  REMOVE_DIR_SCRIPT,
  RESOLVE_DIR_SCRIPT,
  RESOLVE_HOME_SCRIPT,
  RESOLVE_UNLINKED_DIR_SCRIPT,
} from '../sessions/create-host-dir-claims';
import { PLACE_COPY_SCRIPT, REFRESH_COPY_SCRIPT } from '../sessions/create-published-records';
import { CLAIM_DIR_SCRIPT } from '../workspace/claim-landing';
import { ASKPASS_SCRIPT } from '../workspace/create-git-askpass';
import { GUEST_CLONE_SCRIPT } from '../workspace/create-guest-clone';
import { VERIFY_SCRIPT } from '../workspace/verify-target-head';

export const DAEMON_GUEST_SCRIPTS = {
  ASKPASS_SCRIPT,
  CLAIM_DIR_SCRIPT,
  GUEST_CLONE_SCRIPT,
  PLACE_COPY_SCRIPT,
  READ_PROJECT_SETTINGS_SCRIPT,
  REFRESH_COPY_SCRIPT,
  REMOVE_DIR_SCRIPT,
  RESOLVE_DIR_SCRIPT,
  RESOLVE_HOME_SCRIPT,
  RESOLVE_UNLINKED_DIR_SCRIPT,
  VERIFY_SCRIPT,
};
