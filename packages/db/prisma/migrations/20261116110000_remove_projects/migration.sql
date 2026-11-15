-- Projects go (docs/plan/83-remove-projects.md; owner's answers of 15.11.2026): sites, their
-- repositories, imports, previews, candidates, releases and content journal. Chats of projects
-- stay chats without a project, their feed stays as history. The only way back is the dump
-- infra/server/deploy.sh takes before the migrations.

-- A release that may be writing to a hosting stops the migration before anything changes: its
-- outcome would be lost with its rows. Wait for it to end, or resolve it with `releases:resolve`
-- of the running release (this one has no such command) before this release is deployed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM site_releases
    WHERE status IN ('approved', 'publishing', 'published', 'deploying', 'verifying', 'rolling_back', 'unknown')
  ) THEN
    RAISE EXCEPTION 'site_releases holds a release in work or with an unknown outcome: resolve it with releases:resolve of the running release before this one (docs/plan/83-remove-projects.md)';
  END IF;
END
$$;

BEGIN;

-- The requirements of a task are fixed by a trigger that names the columns going below.
DROP TRIGGER "tasks_requirements_fixed" ON "tasks";
DROP TRIGGER "tasks_free_alias" ON "tasks";
DROP TRIGGER "sites_free_alias" ON "sites";
DROP FUNCTION "raditi_tasks_free_alias"();
DROP FUNCTION "raditi_sites_free_alias"();

-- What waits with a candidate waits for words now: there is no candidate to release.
UPDATE "tasks" SET "status" = 'awaiting_user', "updated_at" = now()
  WHERE "status" = 'awaiting_approval';
-- A queued chat waiting for its site waits for agents.
UPDATE "tasks" SET "waiting" = 'agents' WHERE "waiting" = 'site';

-- CHECKs that name the columns of a site.
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_requirements_check";
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_alias_check";
-- A new chat has a UUID of version 7; a chat of a project, made with another, keeps its id.
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_chat_id_check";
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_chat_id_check"
  CHECK ("substring"(("id")::text, 15, 1) = '7') NOT VALID;
ALTER TABLE "credential_refs" DROP CONSTRAINT "credential_refs_site_scope_check";
ALTER TABLE "credential_refs" DROP CONSTRAINT "credential_refs_site_workspace_check";
ALTER TABLE "credential_refs" DROP CONSTRAINT "credential_refs_platform_scope_check";
ALTER TABLE "site_leases" DROP CONSTRAINT "site_leases_mcp_barrier_check";
ALTER TABLE "site_leases" DROP CONSTRAINT "site_leases_release_barrier_check";
ALTER TABLE "site_leases" DROP CONSTRAINT "site_leases_state_check";
ALTER TABLE "plans" DROP CONSTRAINT "plans_kind_fields_check";
ALTER TABLE "plans" DROP CONSTRAINT "plans_limits_check";

-- DropForeignKey
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_site_id_fkey";

-- DropForeignKey
ALTER TABLE "browser_sessions" DROP CONSTRAINT "browser_sessions_site_id_fkey";

-- DropForeignKey
ALTER TABLE "candidate_checks" DROP CONSTRAINT "candidate_checks_candidate_id_fkey";

-- DropForeignKey
ALTER TABLE "channel_identities" DROP CONSTRAINT "channel_identities_new_chat_site_id_fkey";

-- DropForeignKey
ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_site_id_fkey";

-- DropForeignKey
ALTER TABLE "credential_refs" DROP CONSTRAINT "credential_refs_site_id_fkey";

-- DropForeignKey
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_environment_id_fkey";

-- DropForeignKey
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_release_id_fkey";

-- DropForeignKey
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_site_id_fkey";

-- DropForeignKey
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_task_id_fkey";

-- DropForeignKey
ALTER TABLE "environments" DROP CONSTRAINT "environments_site_id_fkey";

-- DropForeignKey
ALTER TABLE "gift_site_claims" DROP CONSTRAINT "gift_site_claims_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "git_repositories" DROP CONSTRAINT "git_repositories_credential_ref_id_fkey";

-- DropForeignKey
ALTER TABLE "git_repositories" DROP CONSTRAINT "git_repositories_site_id_fkey";

-- DropForeignKey
ALTER TABLE "mcp_calls" DROP CONSTRAINT "mcp_calls_assignment_id_fkey";

-- DropForeignKey
ALTER TABLE "mcp_calls" DROP CONSTRAINT "mcp_calls_host_task_id_fkey";

-- DropForeignKey
ALTER TABLE "mcp_calls" DROP CONSTRAINT "mcp_calls_preview_id_fkey";

-- DropForeignKey
ALTER TABLE "mcp_calls" DROP CONSTRAINT "mcp_calls_restores_snapshot_id_fkey";

-- DropForeignKey
ALTER TABLE "mcp_calls" DROP CONSTRAINT "mcp_calls_snapshot_id_fkey";

-- DropForeignKey
ALTER TABLE "mcp_calls" DROP CONSTRAINT "mcp_calls_turn_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_browser_requests" DROP CONSTRAINT "preview_browser_requests_assignment_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_browser_requests" DROP CONSTRAINT "preview_browser_requests_preview_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_db_operations" DROP CONSTRAINT "preview_db_operations_mcp_call_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_db_operations" DROP CONSTRAINT "preview_db_operations_preview_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_db_operations" DROP CONSTRAINT "preview_db_operations_task_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_environments" DROP CONSTRAINT "preview_environments_candidate_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_environments" DROP CONSTRAINT "preview_environments_seed_release_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_environments" DROP CONSTRAINT "preview_environments_site_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_environments" DROP CONSTRAINT "preview_environments_task_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_seed_mismatches" DROP CONSTRAINT "preview_seed_mismatches_preview_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_sessions" DROP CONSTRAINT "preview_sessions_preview_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_sessions" DROP CONSTRAINT "preview_sessions_user_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_sync_requests" DROP CONSTRAINT "preview_sync_requests_assignment_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_sync_requests" DROP CONSTRAINT "preview_sync_requests_preview_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_tickets" DROP CONSTRAINT "preview_tickets_preview_id_fkey";

-- DropForeignKey
ALTER TABLE "preview_tickets" DROP CONSTRAINT "preview_tickets_user_id_fkey";

-- DropForeignKey
ALTER TABLE "release_steps" DROP CONSTRAINT "release_steps_release_id_fkey";

-- DropForeignKey
ALTER TABLE "release_undo_plans" DROP CONSTRAINT "release_undo_plans_release_id_fkey";

-- DropForeignKey
ALTER TABLE "release_undo_plans" DROP CONSTRAINT "release_undo_plans_requested_by_fkey";

-- DropForeignKey
ALTER TABLE "release_undo_plans" DROP CONSTRAINT "release_undo_plans_site_id_fkey";

-- DropForeignKey
ALTER TABLE "site_agent_skills" DROP CONSTRAINT "site_agent_skills_site_id_fkey";

-- DropForeignKey
ALTER TABLE "site_code_sources" DROP CONSTRAINT "site_code_sources_credential_ref_id_fkey";

-- DropForeignKey
ALTER TABLE "site_code_sources" DROP CONSTRAINT "site_code_sources_site_id_fkey";

-- DropForeignKey
ALTER TABLE "site_creation_claims" DROP CONSTRAINT "site_creation_claims_user_id_fkey";

-- DropForeignKey
ALTER TABLE "site_database_dumps" DROP CONSTRAINT "site_database_dumps_site_id_fkey";

-- DropForeignKey
ALTER TABLE "site_database_schemas" DROP CONSTRAINT "site_database_schemas_site_id_fkey";

-- DropForeignKey
ALTER TABLE "site_databases" DROP CONSTRAINT "site_databases_credential_ref_id_fkey";

-- DropForeignKey
ALTER TABLE "site_databases" DROP CONSTRAINT "site_databases_site_id_fkey";

-- DropForeignKey
ALTER TABLE "site_env_vars" DROP CONSTRAINT "site_env_vars_agent_consent_by_fkey";

-- DropForeignKey
ALTER TABLE "site_env_vars" DROP CONSTRAINT "site_env_vars_created_by_fkey";

-- DropForeignKey
ALTER TABLE "site_env_vars" DROP CONSTRAINT "site_env_vars_site_id_fkey";

-- DropForeignKey
ALTER TABLE "site_initial_versions" DROP CONSTRAINT "site_initial_versions_git_repository_id_fkey";

-- DropForeignKey
ALTER TABLE "site_initial_versions" DROP CONSTRAINT "site_initial_versions_site_id_fkey";

-- DropForeignKey
ALTER TABLE "site_leases" DROP CONSTRAINT "site_leases_inflight_mcp_call_id_fkey";

-- DropForeignKey
ALTER TABLE "site_leases" DROP CONSTRAINT "site_leases_inflight_release_id_fkey";

-- DropForeignKey
ALTER TABLE "site_provisioning_stages" DROP CONSTRAINT "site_provisioning_stages_site_id_fkey";

-- DropForeignKey
ALTER TABLE "site_releases" DROP CONSTRAINT "site_releases_approved_by_fkey";

-- DropForeignKey
ALTER TABLE "site_releases" DROP CONSTRAINT "site_releases_candidate_id_fkey";

-- DropForeignKey
ALTER TABLE "site_releases" DROP CONSTRAINT "site_releases_deployment_id_fkey";

-- DropForeignKey
ALTER TABLE "site_releases" DROP CONSTRAINT "site_releases_site_id_fkey";

-- DropForeignKey
ALTER TABLE "site_releases" DROP CONSTRAINT "site_releases_task_id_fkey";

-- DropForeignKey
ALTER TABLE "site_releases" DROP CONSTRAINT "site_releases_undo_plan_id_fkey";

-- DropForeignKey
ALTER TABLE "site_releases" DROP CONSTRAINT "site_releases_undoes_release_id_fkey";

-- DropForeignKey
ALTER TABLE "sites" DROP CONSTRAINT "sites_installed_release_id_fkey";

-- DropForeignKey
ALTER TABLE "sites" DROP CONSTRAINT "sites_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "snapshots" DROP CONSTRAINT "snapshots_preview_id_fkey";

-- DropForeignKey
ALTER TABLE "snapshots" DROP CONSTRAINT "snapshots_site_id_fkey";

-- DropForeignKey
ALTER TABLE "snapshots" DROP CONSTRAINT "snapshots_task_id_fkey";

-- DropForeignKey
ALTER TABLE "task_candidates" DROP CONSTRAINT "task_candidates_task_id_fkey";

-- DropForeignKey
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_deployment_id_fkey";

-- DropForeignKey
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_site_id_fkey";

-- The access of sites: its refs go, the secrets in Vault under kv/sites/ stay unread.
DELETE FROM "credential_refs" WHERE "kind" NOT IN ('llm_provider', 'subscription');
-- A lease of a site, of a release or of a revert: nothing holds it any more. A turn of a chat of
-- a project held its site's lease; its assignment names the chat now, and the chat's own lease
-- row is made by the next turn.
DELETE FROM "site_leases" WHERE "site_id" IN (SELECT "id" FROM "sites");
UPDATE "turn_assignments" SET "site_id" = "task_id" WHERE "site_id" IN (SELECT "id" FROM "sites");
UPDATE "site_leases"
  SET "operation" = NULL, "holder_task_id" = NULL, "expires_at" = NULL, "acquired_at" = NULL,
      "inflight_mcp_call_id" = NULL, "inflight_release_id" = NULL, "held_for_operator" = false
  WHERE ("operation" IS NOT NULL AND "operation" <> 'turn') OR "inflight_mcp_call_id" IS NOT NULL
     OR "inflight_release_id" IS NOT NULL;

-- DropIndex
DROP INDEX "attachments_site_id_idx";

-- DropIndex
DROP INDEX "browser_sessions_site_id_idx";

-- DropIndex
DROP INDEX "channel_identities_new_chat_site_id_idx";

-- DropIndex
DROP INDEX "chat_sessions_workspace_id_site_id_idx";

-- DropIndex
DROP INDEX "credential_refs_site_id_kind_idx";

-- DropIndex
DROP INDEX "site_leases_inflight_mcp_call_id_key";

-- DropIndex
DROP INDEX "site_leases_inflight_release_id_key";

-- DropIndex
DROP INDEX "tasks_deployment_id_key";

-- DropIndex
DROP INDEX "tasks_site_id_alias_key";

-- DropIndex
DROP INDEX "tasks_site_id_status_idx";

-- DropIndex
DROP INDEX "tasks_site_updated_idx";

-- AlterTable
ALTER TABLE "attachments" DROP COLUMN "site_id";

-- AlterTable
ALTER TABLE "browser_sessions" DROP COLUMN "site_id";

-- AlterTable
ALTER TABLE "channel_identities" DROP COLUMN "new_chat_site_id";

-- AlterTable
ALTER TABLE "chat_sessions" DROP COLUMN "site_id";

-- AlterTable
ALTER TABLE "credential_refs" DROP COLUMN "site_id";

-- AlterTable
ALTER TABLE "plans" DROP COLUMN "max_sites";

-- AlterTable
ALTER TABLE "site_leases" DROP COLUMN "inflight_mcp_call_id",
DROP COLUMN "inflight_release_id";

-- AlterTable
ALTER TABLE "tasks" DROP COLUMN "alias",
DROP COLUMN "deployment_id",
DROP COLUMN "needs_repository",
DROP COLUMN "pr_number",
DROP COLUMN "pr_url",
DROP COLUMN "site_id";

-- DropTable
DROP TABLE "candidate_checks";

-- DropTable
DROP TABLE "deployments";

-- DropTable
DROP TABLE "environments";

-- DropTable
DROP TABLE "gift_site_claims";

-- DropTable
DROP TABLE "git_repositories";

-- DropTable
DROP TABLE "mcp_calls";

-- DropTable
DROP TABLE "preview_browser_requests";

-- DropTable
DROP TABLE "preview_db_operations";

-- DropTable
DROP TABLE "preview_environments";

-- DropTable
DROP TABLE "preview_seed_mismatches";

-- DropTable
DROP TABLE "preview_sessions";

-- DropTable
DROP TABLE "preview_sync_requests";

-- DropTable
DROP TABLE "preview_tickets";

-- DropTable
DROP TABLE "release_steps";

-- DropTable
DROP TABLE "release_undo_plans";

-- DropTable
DROP TABLE "site_agent_skills";

-- DropTable
DROP TABLE "site_code_sources";

-- DropTable
DROP TABLE "site_creation_claims";

-- DropTable
DROP TABLE "site_database_dumps";

-- DropTable
DROP TABLE "site_database_schemas";

-- DropTable
DROP TABLE "site_databases";

-- DropTable
DROP TABLE "site_env_vars";

-- DropTable
DROP TABLE "site_initial_versions";

-- DropTable
DROP TABLE "site_provisioning_stages";

-- DropTable
DROP TABLE "site_releases";

-- DropTable
DROP TABLE "sites";

-- DropTable
DROP TABLE "snapshots";

-- DropTable
DROP TABLE "task_candidates";

-- DropEnum
DROP TYPE "CandidateCheckStatus";

-- DropEnum
DROP TYPE "CandidateStatus";

-- DropEnum
DROP TYPE "ConnectionTls";

-- DropEnum
DROP TYPE "DatabaseEngine";

-- DropEnum
DROP TYPE "DbOperationKind";

-- DropEnum
DROP TYPE "DeployMethod";

-- DropEnum
DROP TYPE "DeploymentKind";

-- DropEnum
DROP TYPE "DeploymentStatus";

-- DropEnum
DROP TYPE "DriftPolicy";

-- DropEnum
DROP TYPE "EnvironmentKind";

-- DropEnum
DROP TYPE "GitProviderKind";

-- DropEnum
DROP TYPE "McpCallResult";

-- DropEnum
DROP TYPE "PreviewDbMode";

-- DropEnum
DROP TYPE "PreviewStatus";

-- DropEnum
DROP TYPE "ProvisioningStage";

-- DropEnum
DROP TYPE "ProvisioningStageStatus";

-- DropEnum
DROP TYPE "ReleaseKind";

-- DropEnum
DROP TYPE "ReleaseStatus";

-- DropEnum
DROP TYPE "SiteSourceKind";

-- DropEnum
DROP TYPE "SiteStack";

-- DropEnum
DROP TYPE "SiteStatus";

-- DropEnum
DROP TYPE "UndoPlanStatus";

-- DropEnum
DROP TYPE "VersionBump";

-- CreateIndex
CREATE INDEX "chat_sessions_workspace_id_idx" ON "chat_sessions"("workspace_id");

-- Enums without the values of sites.
CREATE TYPE "CredentialKind_new" AS ENUM ('llm_provider', 'subscription');
ALTER TABLE "credential_refs" ALTER COLUMN "kind" TYPE "CredentialKind_new" USING ("kind"::text::"CredentialKind_new");
ALTER TYPE "CredentialKind" RENAME TO "CredentialKind_old";
ALTER TYPE "CredentialKind_new" RENAME TO "CredentialKind";
DROP TYPE "CredentialKind_old";
CREATE TYPE "LeaseOperation_new" AS ENUM ('turn');
ALTER TABLE "site_leases" ALTER COLUMN "operation" TYPE "LeaseOperation_new" USING ("operation"::text::"LeaseOperation_new");
ALTER TYPE "LeaseOperation" RENAME TO "LeaseOperation_old";
ALTER TYPE "LeaseOperation_new" RENAME TO "LeaseOperation";
DROP TYPE "LeaseOperation_old";
-- AlterEnum

-- AlterEnum

-- CHECKs of what stays.
ALTER TABLE "credential_refs" ADD CONSTRAINT "credential_refs_platform_scope_check"
  CHECK ("workspace_id" IS NULL);
ALTER TABLE "site_leases" ADD CONSTRAINT "site_leases_state_check"
  CHECK ((("holder_task_id" IS NULL) AND ("operation" IS NULL) AND ("expires_at" IS NULL)
      AND (NOT "held_for_operator"))
      OR (("holder_task_id" IS NOT NULL) AND ("operation" IS NOT NULL) AND ("expires_at" IS NOT NULL)));
ALTER TABLE "plans" ADD CONSTRAINT "plans_kind_fields_check"
  CHECK ((("kind" <> 'quota') OR ("credits_per_month" IS NOT NULL))
     AND (("kind" <> 'pack') OR ("pack_credits" IS NOT NULL)));
ALTER TABLE "plans" ADD CONSTRAINT "plans_limits_check"
  CHECK ((("credits_per_month" IS NULL) OR ("credits_per_month" > 0))
     AND (("tasks_per_day" IS NULL) OR ("tasks_per_day" > 0))
     AND (("pack_credits" IS NULL) OR ("pack_credits" > 0)));

-- The requirements of a chat stay fixed once it is made.
CREATE TRIGGER "tasks_requirements_fixed" BEFORE UPDATE ON "tasks" FOR EACH ROW
  WHEN (OLD."needs_browser" IS DISTINCT FROM NEW."needs_browser")
  EXECUTE FUNCTION "raditi_tasks_requirements_fixed"();

COMMIT;
