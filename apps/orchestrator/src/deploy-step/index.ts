// The `deploy-step` command of the orchestrator image (docs/plan/53-chat-preview-release.md,
// Р29–Р31): run by the mandatory deploy workflow of a site (ci/.gitea/scoped_workflows/deploy.yml),
// it checks conflicts, backs up, writes files and records, checks the site, rolls back after a
// failure behind a write and reports each step to the release API of core. It has no database,
// Redis or S3 (dependency-cruiser `deploy-step-no-platform-access`); its contract is
// deploy-manifest.ts of @repo/domain. The entry point is cli.ts, the commands command.ts, the
// deploy itself deploy.ts.
import { DEPLOY_WRAP_SECRET_NAME } from '@repo/domain'

/** The secret of the site's repository the command starts from. */
export const DEPLOY_STEP_SECRET = DEPLOY_WRAP_SECRET_NAME
