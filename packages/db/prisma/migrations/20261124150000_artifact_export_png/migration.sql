-- «Скачать PNG» of a picture of «Изображение» (plan 88, 88.26): an export may name the frame it
-- draws, and its format may be `png`. Additive: existing rows name none.
BEGIN;
ALTER TABLE "artifact_exports" ADD COLUMN "block_key" VARCHAR(40);
ALTER TABLE "artifact_exports" DROP CONSTRAINT "artifact_exports_format_check";
ALTER TABLE "artifact_exports" ADD CONSTRAINT "artifact_exports_format_check"
  CHECK ("format" IN ('xlsx', 'pdf', 'pptx', 'png'));
COMMIT;
