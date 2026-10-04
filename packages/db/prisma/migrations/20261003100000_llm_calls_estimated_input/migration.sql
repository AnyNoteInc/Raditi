-- A lost call is estimated with est_in, the body estimate its reserve was priced with
-- (spec §17, p3-design §4.1 and §4.3): base64 images and encrypted reasoning count by their
-- fixed weights, not by their bytes. llm_calls kept only the raw body size, so the collector
-- could not recover est_in and charged image bytes to the attempt ceiling. NULL marks a call
-- opened before this column existed; the collector keeps estimating it from request_bytes.
-- No row is changed.
ALTER TABLE "llm_calls" ADD COLUMN "estimated_input_tokens" INTEGER
  CONSTRAINT "llm_calls_estimated_input_tokens_check" CHECK ("estimated_input_tokens" >= 0);
