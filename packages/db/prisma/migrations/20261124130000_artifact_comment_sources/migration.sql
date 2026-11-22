-- A dispatch of notes goes on through a ceiling question inside a turn too (88.18в): «Продолжить»
-- after the step or the credits ran out mid-turn carries the same notes as before a turn.
-- Additive: old rows keep their meaning; the code of before reads only questions of no turn.
BEGIN;
ALTER TABLE "task_events" DROP CONSTRAINT "task_events_artifact_comment_source_check";
-- Existing rows already satisfy the narrower check; do not scan the journal during deployment.
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_artifact_comment_source_check" CHECK (
  "artifact_comment_source_id" IS NULL OR (
    "type" = 'feed.question'
    AND ("payload"->>'kind') IS NOT DISTINCT FROM 'ceiling'
    AND "artifact_comment_source_id" > 0 AND "artifact_comment_source_id" < "id"
  )
) NOT VALID;
COMMIT;
