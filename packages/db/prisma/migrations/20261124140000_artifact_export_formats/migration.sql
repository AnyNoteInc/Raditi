-- The PDF and the PPTX of «Презентация» (plan 88, 88.25в): the formats of an export widen. Existing
-- rows are all `xlsx` and keep their meaning.
BEGIN;
ALTER TABLE "artifact_exports" DROP CONSTRAINT "artifact_exports_format_check";
ALTER TABLE "artifact_exports" ADD CONSTRAINT "artifact_exports_format_check"
  CHECK ("format" IN ('xlsx', 'pdf', 'pptx'));
COMMIT;
