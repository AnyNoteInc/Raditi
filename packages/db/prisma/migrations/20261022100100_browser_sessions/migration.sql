-- The cloud browser of a task (docs/plan/57-browser-tasks.md, Б10–Б24, §3.4): its session as the
-- browser worker keeps it, the one-time tickets of the stream a cabinet watches it through, and
-- the objects the task made on the site through it. New types and tables only: no row there is
-- is read or changed. Nothing secret is stored — the sign-in of a session lives only in its
-- browser (Б19), and a ticket is kept as its SHA-256.
BEGIN;

-- Must equal browserSessionStatuses, browserControllers and browserCheckpointStates in
-- @repo/domain (checked by a test).
CREATE TYPE "BrowserSessionStatus" AS ENUM ('starting', 'ready', 'closed', 'failed', 'lost');
CREATE TYPE "BrowserController" AS ENUM ('agent', 'user');
CREATE TYPE "BrowserCheckpointState" AS ENUM ('seen', 'unverified', 'verified', 'missing');

-- ─── Sessions ───────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "browser_sessions" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "status" "BrowserSessionStatus" NOT NULL DEFAULT 'starting',
    "controller" "BrowserController" NOT NULL DEFAULT 'agent',
    "control_epoch" INTEGER NOT NULL DEFAULT 0,
    "viewport_version" INTEGER NOT NULL DEFAULT 1,
    "help_reason" VARCHAR(16),
    "help_message" VARCHAR(500),
    "wrote_at" TIMESTAMPTZ(6),
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "close_reason" VARCHAR(32),
    "error_code" VARCHAR(48),

    CONSTRAINT "browser_sessions_pkey" PRIMARY KEY ("id"),
    -- A session that holds no browser any more says when and why it stopped.
    CONSTRAINT "browser_sessions_closed_check" CHECK (
      ("status" IN ('closed', 'failed', 'lost')) = ("closed_at" IS NOT NULL)
      AND ("closed_at" IS NULL) = ("close_reason" IS NULL)
    ),
    -- One of browserCloseReasons; the list lives in the domain and grows without a migration.
    CONSTRAINT "browser_sessions_close_reason_check" CHECK ("close_reason" ~ '^[a-z][a-z_]{0,31}$'),
    CONSTRAINT "browser_sessions_error_code_check" CHECK ("error_code" ~ '^[A-Za-z][A-Za-z0-9_]{0,47}$'),
    CONSTRAINT "browser_sessions_ready_check" CHECK (
      CASE "status"
        WHEN 'starting' THEN "ready_at" IS NULL
        WHEN 'ready' THEN "ready_at" IS NOT NULL
        ELSE true
      END
    ),
    CONSTRAINT "browser_sessions_control_epoch_check" CHECK ("control_epoch" >= 0),
    CONSTRAINT "browser_sessions_viewport_version_check" CHECK ("viewport_version" >= 1),
    -- What the agent asked the client to do (`web_help`): a reason of browserHelpReasons and its
    -- words, together or neither.
    CONSTRAINT "browser_sessions_help_check" CHECK (
      ("help_reason" IS NULL) = ("help_message" IS NULL)
      AND ("help_reason" IS NULL OR "help_reason" IN ('login', 'captcha', 'confirm', 'other'))
      AND ("help_message" IS NULL OR char_length("help_message") BETWEEN 1 AND 500)
    ),
    CONSTRAINT "browser_sessions_expiry_check" CHECK ("expires_at" > "created_at")
);

-- One session that still holds a browser per task: the next turn finds it (Б18).
CREATE UNIQUE INDEX "browser_sessions_open_task_key" ON "browser_sessions"("task_id")
  WHERE "status" IN ('starting', 'ready');
CREATE INDEX "browser_sessions_task_id_idx" ON "browser_sessions"("task_id");
CREATE INDEX "browser_sessions_site_id_idx" ON "browser_sessions"("site_id");
CREATE INDEX "browser_sessions_workspace_id_idx" ON "browser_sessions"("workspace_id");
CREATE INDEX "browser_sessions_status_expires_at_idx" ON "browser_sessions"("status", "expires_at");

-- ─── Stream tickets (Б12) ───────────────────────────────────────────────────────────────────────

CREATE TABLE "browser_stream_tickets" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "browser_stream_tickets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "browser_stream_tickets_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "browser_stream_tickets_expiry_check" CHECK ("expires_at" > "created_at")
);

CREATE UNIQUE INDEX "browser_stream_tickets_token_hash_key" ON "browser_stream_tickets"("token_hash");
CREATE INDEX "browser_stream_tickets_session_id_idx" ON "browser_stream_tickets"("session_id");
CREATE INDEX "browser_stream_tickets_user_id_idx" ON "browser_stream_tickets"("user_id");
CREATE INDEX "browser_stream_tickets_expires_at_idx" ON "browser_stream_tickets"("expires_at");

-- ─── Checkpoints (Б22) ──────────────────────────────────────────────────────────────────────────

CREATE TABLE "browser_checkpoints" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "object_id" VARCHAR(64) NOT NULL,
    "edit_url" VARCHAR(2048) NOT NULL,
    "state" "BrowserCheckpointState" NOT NULL DEFAULT 'seen',
    "verified" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "browser_checkpoints_pkey" PRIMARY KEY ("id"),
    -- One of browserCheckpointKinds, and an id as browserObjectIdSchema takes it.
    CONSTRAINT "browser_checkpoints_object_check" CHECK (
      "kind" ~ '^[a-z][a-z_]{0,15}$' AND "object_id" ~ '^[A-Za-z0-9_-]{1,64}$'
    ),
    -- What a trusted read found is kept exactly while the object is confirmed.
    CONSTRAINT "browser_checkpoints_verified_check" CHECK (
      ("state" = 'verified') = ("verified" IS NOT NULL)
      AND ("verified" IS NULL OR jsonb_typeof("verified") = 'object')
    )
);

CREATE UNIQUE INDEX "browser_checkpoints_task_id_kind_object_id_key" ON "browser_checkpoints"("task_id", "kind", "object_id");
CREATE INDEX "browser_checkpoints_session_id_idx" ON "browser_checkpoints"("session_id");

-- ─── Foreign keys: the browser of a task lives and dies with it, like its events ────────────────

ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "browser_stream_tickets" ADD CONSTRAINT "browser_stream_tickets_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "browser_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "browser_stream_tickets" ADD CONSTRAINT "browser_stream_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "browser_checkpoints" ADD CONSTRAINT "browser_checkpoints_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "browser_checkpoints" ADD CONSTRAINT "browser_checkpoints_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "browser_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
