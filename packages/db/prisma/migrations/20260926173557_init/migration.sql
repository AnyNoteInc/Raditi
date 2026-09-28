-- CreateEnum
CREATE TYPE "ConsentDocumentType" AS ENUM ('user_agreement', 'privacy_policy', 'pii_processing', 'public_offer', 'marketing');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('sign_up', 'onboarding', 'settings');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('web', 'telegram', 'max');

-- CreateEnum
CREATE TYPE "SiteStack" AS ENUM ('wordpress', 'bitrix', 'laravel', 'static', 'node', 'python');

-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('onboarding', 'active', 'paused', 'disconnected', 'archived');

-- CreateEnum
CREATE TYPE "DriftPolicy" AS ENUM ('sync', 'freeze');

-- CreateEnum
CREATE TYPE "LeaseOperation" AS ENUM ('turn', 'deploy', 'revert');

-- CreateEnum
CREATE TYPE "GitProviderKind" AS ENUM ('gitea', 'github', 'gitlab');

-- CreateEnum
CREATE TYPE "EnvironmentKind" AS ENUM ('prod');

-- CreateEnum
CREATE TYPE "DeployMethod" AS ENUM ('rsync', 'git_ftp', 'docker');

-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('ssh', 'ftp', 'wp', 'browser', 'git', 'llm_provider', 'subscription');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('queued', 'preparing', 'running', 'awaiting_user', 'awaiting_approval', 'deploying', 'verifying', 'done', 'failed', 'rolled_back', 'cancelled');

-- CreateEnum
CREATE TYPE "ChangeType" AS ENUM ('code', 'content', 'mixed', 'none');

-- CreateEnum
CREATE TYPE "ModelClass" AS ENUM ('light', 'standard', 'heavy', 'service');

-- CreateEnum
CREATE TYPE "TurnStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'lost');

-- CreateEnum
CREATE TYPE "McpCallResult" AS ENUM ('ok', 'error', 'denied');

-- CreateEnum
CREATE TYPE "DeploymentKind" AS ENUM ('deploy', 'revert');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'rolled_back', 'cancelled', 'unknown');

-- CreateEnum
CREATE TYPE "LlmProviderKind" AS ENUM ('api', 'subscription');

-- CreateEnum
CREATE TYPE "PlanKind" AS ENUM ('quota', 'payg', 'pack');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trial', 'active', 'past_due', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "BillingUnit" AS ENUM ('edit', 'rub');

-- CreateEnum
CREATE TYPE "HoldStatus" AS ENUM ('active', 'captured', 'released', 'expired');

-- CreateEnum
CREATE TYPE "LedgerKind" AS ENUM ('grant', 'topup', 'charge', 'refund', 'expire', 'adjust');

-- CreateEnum
CREATE TYPE "OrderKind" AS ENUM ('subscription', 'pack', 'topup');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'paid', 'failed', 'refunded', 'cancelled');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('pending', 'succeeded', 'cancelled');

-- CreateEnum
CREATE TYPE "OutboxEventStatus" AS ENUM ('pending', 'published', 'failed');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('user', 'agent', 'system', 'operator');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" VARCHAR(1024),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(1024),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_id" VARCHAR(255) NOT NULL,
    "account_id" VARCHAR(255) NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(6),
    "refresh_token_expires_at" TIMESTAMPTZ(6),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limits" (
    "id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "count" INTEGER NOT NULL,
    "last_request" BIGINT NOT NULL,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_consents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "document_type" "ConsentDocumentType" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "document_version" VARCHAR(80) NOT NULL,
    "source" "ConsentSource" NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(1024),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "Channel" NOT NULL,
    "external_id" VARCHAR(64) NOT NULL,
    "username" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "url" VARCHAR(512) NOT NULL,
    "stack" "SiteStack" NOT NULL,
    "status" "SiteStatus" NOT NULL DEFAULT 'onboarding',
    "drift_policy" "DriftPolicy" NOT NULL DEFAULT 'sync',
    "operator_review" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_leases" (
    "site_id" UUID NOT NULL,
    "operation" "LeaseOperation",
    "holder_task_id" UUID,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "acquired_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "held_for_operator" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_leases_pkey" PRIMARY KEY ("site_id")
);

-- CreateTable
CREATE TABLE "git_repositories" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "provider" "GitProviderKind" NOT NULL,
    "owner" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "default_branch" VARCHAR(255) NOT NULL DEFAULT 'main',
    "url" VARCHAR(1024) NOT NULL,
    "credential_ref_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "git_repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environments" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "kind" "EnvironmentKind" NOT NULL DEFAULT 'prod',
    "host" VARCHAR(255) NOT NULL,
    "port" INTEGER,
    "deploy_method" "DeployMethod" NOT NULL,
    "path" VARCHAR(1024) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_refs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "site_id" UUID,
    "kind" "CredentialKind" NOT NULL,
    "vault_path" VARCHAR(512) NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credential_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID,
    "channel" "Channel" NOT NULL,
    "external_chat_id" VARCHAR(64),
    "telegram_topic_id" INTEGER,
    "agent_driver_id" VARCHAR(32),
    "last_turn_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "chat_session_id" UUID,
    "created_by_id" UUID,
    "reverts_task_id" UUID,
    "status" "TaskStatus" NOT NULL DEFAULT 'queued',
    "change_type" "ChangeType",
    "model_class" "ModelClass",
    "summary" VARCHAR(500),
    "turn_no" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "pr_number" INTEGER,
    "pr_url" VARCHAR(1024),
    "deployment_id" UUID,
    "pricing_rule_id" UUID,
    "cost_rub" DECIMAL(18,10) NOT NULL DEFAULT 0,
    "billed_rub" DECIMAL(12,2),
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_turns" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "turn_no" INTEGER NOT NULL,
    "status" "TurnStatus" NOT NULL DEFAULT 'pending',
    "driver_id" VARCHAR(32) NOT NULL,
    "driver_version" VARCHAR(64),
    "image" VARCHAR(512) NOT NULL,
    "model_id" UUID,
    "native_session_id" VARCHAR(200),
    "snapshot_prefix" VARCHAR(512),
    "litellm_key_hash" VARCHAR(64),
    "base_sha" VARCHAR(64),
    "head_sha" VARCHAR(64),
    "failure_reason" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "task_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_events" (
    "id" BIGSERIAL NOT NULL,
    "task_id" UUID NOT NULL,
    "turn_id" UUID,
    "type" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "client_visible" BOOLEAN NOT NULL DEFAULT false,
    "s3_key" VARCHAR(1024),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_calls" (
    "id" UUID NOT NULL,
    "turn_id" UUID NOT NULL,
    "tool" VARCHAR(200) NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "object_ref" VARCHAR(1024),
    "snapshot_id" UUID,
    "result" "McpCallResult",
    "response" JSONB,
    "error" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "reverted_at" TIMESTAMPTZ(6),

    CONSTRAINT "mcp_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "uploaded_by_id" UUID,
    "source" "Channel" NOT NULL,
    "s3_key" VARCHAR(1024) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(255) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snapshots" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "task_id" UUID,
    "object_ref" VARCHAR(1024) NOT NULL,
    "s3_key" VARCHAR(1024) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "restored_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "kind" "DeploymentKind" NOT NULL DEFAULT 'deploy',
    "status" "DeploymentStatus" NOT NULL DEFAULT 'pending',
    "commit_sha" VARCHAR(64),
    "workflow_run_id" VARCHAR(64),
    "backup_prefix" VARCHAR(512),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_drivers" (
    "id" VARCHAR(32) NOT NULL,
    "image" VARCHAR(512) NOT NULL,
    "capabilities" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_providers" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "kind" "LlmProviderKind" NOT NULL DEFAULT 'api',
    "credential_ref_id" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "llm_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_models" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "slug" VARCHAR(128) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "provider_model_id" VARCHAR(255),
    "model_class" "ModelClass" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "llm_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_model_prices" (
    "id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "input_per_1m" DECIMAL(14,6) NOT NULL,
    "cache_read_per_1m" DECIMAL(14,6),
    "cache_write_per_1m" DECIMAL(14,6),
    "output_per_1m" DECIMAL(14,6) NOT NULL,
    "vat_rate" DECIMAL(5,4) NOT NULL,
    "source_url" VARCHAR(1024) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_model_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_usage" (
    "id" UUID NOT NULL,
    "gateway_call_id" VARCHAR(128) NOT NULL,
    "task_id" UUID NOT NULL,
    "turn_id" UUID NOT NULL,
    "driver_id" VARCHAR(32) NOT NULL,
    "model_id" UUID NOT NULL,
    "price_id" UUID NOT NULL,
    "input_uncached_tokens" INTEGER NOT NULL,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL,
    "reasoning_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_rub" DECIMAL(18,10) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_accounts" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "driver_id" VARCHAR(32),
    "label" VARCHAR(255) NOT NULL,
    "credential_ref_id" UUID NOT NULL,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscription_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "kind" "PlanKind" NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "edits_per_month" INTEGER,
    "edits_per_day" INTEGER,
    "pack_edits" INTEGER,
    "max_sites" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "model_class" "ModelClass" NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "markup" DECIMAL(8,4) NOT NULL,
    "fee_per_action" DECIMAL(12,2) NOT NULL,
    "min_charge" DECIMAL(12,2) NOT NULL,
    "hold_amount" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "current_period_start" TIMESTAMPTZ(6) NOT NULL,
    "current_period_end" TIMESTAMPTZ(6) NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_at" TIMESTAMPTZ(6),
    "payment_method_id" VARCHAR(64),
    "payment_method_title" VARCHAR(128),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_accounts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "unit" "BillingUnit" NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "held" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_holds" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "HoldStatus" NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMPTZ(6),

    CONSTRAINT "credit_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "unit" "BillingUnit" NOT NULL,
    "kind" "LedgerKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "balance_after" DECIMAL(14,2) NOT NULL,
    "task_id" UUID,
    "order_id" UUID,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID,
    "kind" "OrderKind" NOT NULL,
    "plan_id" UUID,
    "subscription_id" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending',
    "yookassa_payment_id" VARCHAR(64),
    "idempotence_key" VARCHAR(64) NOT NULL,
    "receipt_status" "ReceiptStatus" NOT NULL DEFAULT 'pending',
    "save_payment_method" BOOLEAN NOT NULL DEFAULT false,
    "paid_at" TIMESTAMPTZ(6),
    "refunded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "topic" VARCHAR(64) NOT NULL,
    "type" VARCHAR(128) NOT NULL,
    "payload" JSONB,
    "dedupe_key" VARCHAR(255),
    "status" "OutboxEventStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(6),
    "locked_by" VARCHAR(64),
    "published_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" VARCHAR(128),
    "workspace_id" UUID,
    "action" VARCHAR(128) NOT NULL,
    "target_type" VARCHAR(64),
    "target_id" VARCHAR(128),
    "meta" JSONB,
    "ip" VARCHAR(45),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_id_account_id_key" ON "accounts"("provider_id", "account_id");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limits_key_key" ON "rate_limits"("key");

-- CreateIndex
CREATE INDEX "user_consents_user_id_document_type_created_at_idx" ON "user_consents"("user_id", "document_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "workspaces_created_by_id_idx" ON "workspaces"("created_by_id");

-- CreateIndex
CREATE INDEX "members_user_id_idx" ON "members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "members_workspace_id_user_id_key" ON "members"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "channel_identities_user_id_idx" ON "channel_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_identities_channel_external_id_key" ON "channel_identities"("channel", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "sites_workspace_id_url_key" ON "sites"("workspace_id", "url");

-- CreateIndex
CREATE INDEX "site_leases_holder_task_id_idx" ON "site_leases"("holder_task_id");

-- CreateIndex
CREATE INDEX "git_repositories_site_id_idx" ON "git_repositories"("site_id");

-- CreateIndex
CREATE INDEX "git_repositories_credential_ref_id_idx" ON "git_repositories"("credential_ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "git_repositories_provider_owner_name_key" ON "git_repositories"("provider", "owner", "name");

-- CreateIndex
CREATE UNIQUE INDEX "environments_site_id_kind_key" ON "environments"("site_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "credential_refs_vault_path_key" ON "credential_refs"("vault_path");

-- CreateIndex
CREATE INDEX "credential_refs_workspace_id_idx" ON "credential_refs"("workspace_id");

-- CreateIndex
CREATE INDEX "credential_refs_site_id_kind_idx" ON "credential_refs"("site_id", "kind");

-- CreateIndex
CREATE INDEX "chat_sessions_workspace_id_site_id_idx" ON "chat_sessions"("workspace_id", "site_id");

-- CreateIndex
CREATE INDEX "chat_sessions_channel_external_chat_id_telegram_topic_id_idx" ON "chat_sessions"("channel", "external_chat_id", "telegram_topic_id");

-- CreateIndex
CREATE INDEX "chat_sessions_agent_driver_id_idx" ON "chat_sessions"("agent_driver_id");

-- CreateIndex
CREATE INDEX "chat_sessions_last_turn_id_idx" ON "chat_sessions"("last_turn_id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_deployment_id_key" ON "tasks"("deployment_id");

-- CreateIndex
CREATE INDEX "tasks_workspace_id_created_at_idx" ON "tasks"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "tasks_site_id_status_idx" ON "tasks"("site_id", "status");

-- CreateIndex
CREATE INDEX "tasks_status_updated_at_idx" ON "tasks"("status", "updated_at");

-- CreateIndex
CREATE INDEX "tasks_chat_session_id_idx" ON "tasks"("chat_session_id");

-- CreateIndex
CREATE INDEX "tasks_created_by_id_idx" ON "tasks"("created_by_id");

-- CreateIndex
CREATE INDEX "tasks_reverts_task_id_idx" ON "tasks"("reverts_task_id");

-- CreateIndex
CREATE INDEX "tasks_pricing_rule_id_idx" ON "tasks"("pricing_rule_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_turns_litellm_key_hash_key" ON "task_turns"("litellm_key_hash");

-- CreateIndex
CREATE INDEX "task_turns_driver_id_idx" ON "task_turns"("driver_id");

-- CreateIndex
CREATE INDEX "task_turns_model_id_idx" ON "task_turns"("model_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_turns_task_id_turn_no_key" ON "task_turns"("task_id", "turn_no");

-- CreateIndex
CREATE INDEX "task_events_task_id_id_idx" ON "task_events"("task_id", "id");

-- CreateIndex
CREATE INDEX "task_events_turn_id_idx" ON "task_events"("turn_id");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_calls_idempotency_key_key" ON "mcp_calls"("idempotency_key");

-- CreateIndex
CREATE INDEX "mcp_calls_turn_id_idx" ON "mcp_calls"("turn_id");

-- CreateIndex
CREATE INDEX "mcp_calls_snapshot_id_idx" ON "mcp_calls"("snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_s3_key_key" ON "attachments"("s3_key");

-- CreateIndex
CREATE INDEX "attachments_task_id_idx" ON "attachments"("task_id");

-- CreateIndex
CREATE INDEX "attachments_uploaded_by_id_idx" ON "attachments"("uploaded_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "snapshots_s3_key_key" ON "snapshots"("s3_key");

-- CreateIndex
CREATE INDEX "snapshots_site_id_object_ref_idx" ON "snapshots"("site_id", "object_ref");

-- CreateIndex
CREATE INDEX "snapshots_task_id_idx" ON "snapshots"("task_id");

-- CreateIndex
CREATE INDEX "snapshots_expires_at_idx" ON "snapshots"("expires_at");

-- CreateIndex
CREATE INDEX "deployments_site_id_created_at_idx" ON "deployments"("site_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "deployments_environment_id_idx" ON "deployments"("environment_id");

-- CreateIndex
CREATE INDEX "deployments_task_id_idx" ON "deployments"("task_id");

-- CreateIndex
CREATE INDEX "deployments_commit_sha_idx" ON "deployments"("commit_sha");

-- CreateIndex
CREATE UNIQUE INDEX "llm_providers_slug_key" ON "llm_providers"("slug");

-- CreateIndex
CREATE INDEX "llm_providers_credential_ref_id_idx" ON "llm_providers"("credential_ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "llm_models_provider_id_slug_key" ON "llm_models"("provider_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "llm_model_prices_model_id_effective_from_key" ON "llm_model_prices"("model_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "token_usage_gateway_call_id_key" ON "token_usage"("gateway_call_id");

-- CreateIndex
CREATE INDEX "token_usage_task_id_turn_id_idx" ON "token_usage"("task_id", "turn_id");

-- CreateIndex
CREATE INDEX "token_usage_turn_id_idx" ON "token_usage"("turn_id");

-- CreateIndex
CREATE INDEX "token_usage_model_id_occurred_at_idx" ON "token_usage"("model_id", "occurred_at");

-- CreateIndex
CREATE INDEX "token_usage_occurred_at_idx" ON "token_usage"("occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_accounts_credential_ref_id_key" ON "subscription_accounts"("credential_ref_id");

-- CreateIndex
CREATE INDEX "subscription_accounts_provider_id_idx" ON "subscription_accounts"("provider_id");

-- CreateIndex
CREATE INDEX "subscription_accounts_driver_id_idx" ON "subscription_accounts"("driver_id");

-- CreateIndex
CREATE UNIQUE INDEX "plans_slug_key" ON "plans"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_rules_plan_id_model_class_effective_from_key" ON "pricing_rules"("plan_id", "model_class", "effective_from");

-- CreateIndex
CREATE INDEX "subscriptions_workspace_id_idx" ON "subscriptions"("workspace_id");

-- CreateIndex
CREATE INDEX "subscriptions_plan_id_idx" ON "subscriptions"("plan_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_current_period_end_idx" ON "subscriptions"("status", "current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_workspace_id_unit_key" ON "billing_accounts"("workspace_id", "unit");

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_id_unit_key" ON "billing_accounts"("id", "unit");

-- CreateIndex
CREATE INDEX "credit_holds_account_id_status_idx" ON "credit_holds"("account_id", "status");

-- CreateIndex
CREATE INDEX "credit_holds_status_expires_at_idx" ON "credit_holds"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "credit_holds_task_id_attempt_key" ON "credit_holds"("task_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_idempotency_key_key" ON "credit_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "credit_ledger_account_id_created_at_idx" ON "credit_ledger"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "credit_ledger_task_id_idx" ON "credit_ledger"("task_id");

-- CreateIndex
CREATE INDEX "credit_ledger_order_id_idx" ON "credit_ledger"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_yookassa_payment_id_key" ON "orders"("yookassa_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotence_key_key" ON "orders"("idempotence_key");

-- CreateIndex
CREATE INDEX "orders_workspace_id_created_at_idx" ON "orders"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_user_id_idx" ON "orders"("user_id");

-- CreateIndex
CREATE INDEX "orders_plan_id_idx" ON "orders"("plan_id");

-- CreateIndex
CREATE INDEX "orders_subscription_id_idx" ON "orders"("subscription_id");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_dedupe_key_key" ON "outbox_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "audit_log_workspace_id_created_at_idx" ON "audit_log"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_actor_type_actor_id_created_at_idx" ON "audit_log"("actor_type", "actor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_target_type_target_id_idx" ON "audit_log"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_leases" ADD CONSTRAINT "site_leases_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_leases" ADD CONSTRAINT "site_leases_holder_task_id_fkey" FOREIGN KEY ("holder_task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "git_repositories" ADD CONSTRAINT "git_repositories_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "git_repositories" ADD CONSTRAINT "git_repositories_credential_ref_id_fkey" FOREIGN KEY ("credential_ref_id") REFERENCES "credential_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environments" ADD CONSTRAINT "environments_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_refs" ADD CONSTRAINT "credential_refs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_refs" ADD CONSTRAINT "credential_refs_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_agent_driver_id_fkey" FOREIGN KEY ("agent_driver_id") REFERENCES "agent_drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_last_turn_id_fkey" FOREIGN KEY ("last_turn_id") REFERENCES "task_turns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_chat_session_id_fkey" FOREIGN KEY ("chat_session_id") REFERENCES "chat_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reverts_task_id_fkey" FOREIGN KEY ("reverts_task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_pricing_rule_id_fkey" FOREIGN KEY ("pricing_rule_id") REFERENCES "pricing_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_turns" ADD CONSTRAINT "task_turns_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_turns" ADD CONSTRAINT "task_turns_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "agent_drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_turns" ADD CONSTRAINT "task_turns_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "llm_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "task_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "task_turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_credential_ref_id_fkey" FOREIGN KEY ("credential_ref_id") REFERENCES "credential_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_models" ADD CONSTRAINT "llm_models_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "llm_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_model_prices" ADD CONSTRAINT "llm_model_prices_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "llm_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "task_turns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "agent_drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "llm_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "llm_model_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_accounts" ADD CONSTRAINT "subscription_accounts_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "llm_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_accounts" ADD CONSTRAINT "subscription_accounts_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "agent_drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_accounts" ADD CONSTRAINT "subscription_accounts_credential_ref_id_fkey" FOREIGN KEY ("credential_ref_id") REFERENCES "credential_refs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "billing_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_account_id_unit_fkey" FOREIGN KEY ("account_id", "unit") REFERENCES "billing_accounts"("id", "unit") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── CHECK constraints (hand-written) ────────────────────────────────────────
-- Prisma cannot express CHECK constraints and ignores them when diffing, so later migrations
-- keep them. Money and quota invariants (spec §16, §17) live here, at the lowest layer.

-- Billing accounts: balances never go negative, holds never exceed the balance, edits are whole.
ALTER TABLE "billing_accounts"
  ADD CONSTRAINT "billing_accounts_balance_check" CHECK ("balance" >= 0),
  ADD CONSTRAINT "billing_accounts_held_check" CHECK ("held" >= 0),
  ADD CONSTRAINT "billing_accounts_held_le_balance_check" CHECK ("held" <= "balance"),
  ADD CONSTRAINT "billing_accounts_edit_whole_check"
    CHECK ("unit" <> 'edit' OR ("balance" = trunc("balance") AND "held" = trunc("held")));

-- Holds: a positive reserve; attempts count from 1.
ALTER TABLE "credit_holds"
  ADD CONSTRAINT "credit_holds_amount_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "credit_holds_attempt_check" CHECK ("attempt" >= 1);

-- Ledger: edits move in whole units; the running balance never goes negative.
ALTER TABLE "credit_ledger"
  ADD CONSTRAINT "credit_ledger_edit_whole_check" CHECK ("unit" <> 'edit' OR "amount" = trunc("amount")),
  ADD CONSTRAINT "credit_ledger_balance_after_check" CHECK ("balance_after" >= 0);

-- Plans: non-negative price; quotas and site limits are positive when set; each kind has its fields.
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_price_check" CHECK ("price" >= 0),
  ADD CONSTRAINT "plans_limits_check" CHECK (
    ("edits_per_month" IS NULL OR "edits_per_month" > 0)
    AND ("edits_per_day" IS NULL OR "edits_per_day" > 0)
    AND ("pack_edits" IS NULL OR "pack_edits" > 0)
    AND ("max_sites" IS NULL OR "max_sites" > 0)
  ),
  ADD CONSTRAINT "plans_kind_fields_check" CHECK (
    ("kind" <> 'quota' OR ("edits_per_month" IS NOT NULL AND "max_sites" IS NOT NULL))
    AND ("kind" <> 'pack' OR "pack_edits" IS NOT NULL)
  );

-- Pricing rules: price = clamp(fee + Σcost × markup, min_charge, hold_amount) needs min <= hold.
ALTER TABLE "pricing_rules"
  ADD CONSTRAINT "pricing_rules_markup_check" CHECK ("markup" > 0),
  ADD CONSTRAINT "pricing_rules_fee_check" CHECK ("fee_per_action" >= 0),
  ADD CONSTRAINT "pricing_rules_min_charge_check" CHECK ("min_charge" >= 0),
  ADD CONSTRAINT "pricing_rules_hold_check" CHECK ("hold_amount" >= "min_charge");

-- Provider prices: non-negative; VAT rate is a fraction in [0, 1).
ALTER TABLE "llm_model_prices"
  ADD CONSTRAINT "llm_model_prices_prices_check" CHECK (
    "input_per_1m" >= 0
    AND ("cache_read_per_1m" IS NULL OR "cache_read_per_1m" >= 0)
    AND ("cache_write_per_1m" IS NULL OR "cache_write_per_1m" >= 0)
    AND "output_per_1m" >= 0
  ),
  ADD CONSTRAINT "llm_model_prices_vat_rate_check" CHECK ("vat_rate" >= 0 AND "vat_rate" < 1);

-- Token usage: counts and cost are never negative.
ALTER TABLE "token_usage"
  ADD CONSTRAINT "token_usage_tokens_check" CHECK (
    "input_uncached_tokens" >= 0
    AND "cache_read_tokens" >= 0
    AND "cache_write_tokens" >= 0
    AND "output_tokens" >= 0
    AND "reasoning_tokens" >= 0
  ),
  ADD CONSTRAINT "token_usage_cost_check" CHECK ("cost_rub" >= 0);

-- Orders: a positive amount; subscription and pack orders name a plan, top-ups do not.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amount_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "orders_plan_check" CHECK (("kind" = 'topup') = ("plan_id" IS NULL));

-- Tasks: cost and price are never negative; turn and attempt counters.
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_cost_check" CHECK ("cost_rub" >= 0),
  ADD CONSTRAINT "tasks_billed_check" CHECK ("billed_rub" IS NULL OR "billed_rub" >= 0),
  ADD CONSTRAINT "tasks_turn_no_check" CHECK ("turn_no" >= 0),
  ADD CONSTRAINT "tasks_attempt_check" CHECK ("attempt" >= 1);

ALTER TABLE "task_turns"
  ADD CONSTRAINT "task_turns_turn_no_check" CHECK ("turn_no" >= 1);

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_size_check" CHECK ("size_bytes" >= 0);

-- Site lease: free (no holder, operation or expiry) or held (holder, operation and expiry).
ALTER TABLE "site_leases"
  ADD CONSTRAINT "site_leases_state_check" CHECK (
    ("holder_task_id" IS NULL AND "operation" IS NULL AND "expires_at" IS NULL AND NOT "held_for_operator")
    OR ("holder_task_id" IS NOT NULL AND "operation" IS NOT NULL AND "expires_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "site_leases_epoch_check" CHECK ("epoch" >= 0);

-- Credential refs: site access belongs to a site; provider keys and subscriptions to the platform.
ALTER TABLE "credential_refs"
  ADD CONSTRAINT "credential_refs_site_scope_check"
    CHECK ("kind" NOT IN ('ssh', 'ftp', 'wp', 'browser') OR "site_id" IS NOT NULL),
  ADD CONSTRAINT "credential_refs_platform_scope_check"
    CHECK ("kind" NOT IN ('llm_provider', 'subscription') OR ("workspace_id" IS NULL AND "site_id" IS NULL)),
  ADD CONSTRAINT "credential_refs_site_workspace_check" CHECK ("site_id" IS NULL OR "workspace_id" IS NOT NULL);
