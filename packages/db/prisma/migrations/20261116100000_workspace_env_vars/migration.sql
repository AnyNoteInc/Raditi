-- Variables of a workspace (docs/plan/83-remove-projects.md, БП4): «Настройки → Переменные».
CREATE TABLE "workspace_env_vars" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workspace_env_vars_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workspace_env_vars_name_check" CHECK ("name" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    CONSTRAINT "workspace_env_vars_key_version_check" CHECK ("key_version" >= 1)
);

CREATE UNIQUE INDEX "workspace_env_vars_workspace_id_name_key" ON "workspace_env_vars"("workspace_id", "name");
CREATE INDEX "workspace_env_vars_created_by_idx" ON "workspace_env_vars"("created_by");

ALTER TABLE "workspace_env_vars" ADD CONSTRAINT "workspace_env_vars_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_env_vars" ADD CONSTRAINT "workspace_env_vars_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
