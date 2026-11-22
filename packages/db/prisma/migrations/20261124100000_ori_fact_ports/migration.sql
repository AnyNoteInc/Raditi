-- The port of the client for the facts of the ORI (Government Decree № 1526, p. 3 «б», «в», «е», «з»;
-- plan 88, slice 88.16а-2); additive. The edge alone sees the port: web answers an action with a
-- fact by the header `X-Raditi-Fact` carrying the fact's random `edge_key` (a key, never the id — an
-- id would tell how many facts there are), Traefik keeps that one header of the response in its
-- access line beside `ClientPort`, and the collector on the host moves the pairs here before
-- journald forgets them (90 days). Kept as long as facts; append only, as the journals are.
BEGIN;
ALTER TABLE "ori_facts" ADD COLUMN "edge_key" UUID;
CREATE UNIQUE INDEX "ori_facts_edge_key_key" ON "ori_facts"("edge_key");

CREATE TABLE "ori_fact_ports" (
  "edge_key" UUID NOT NULL,
  "port" INTEGER NOT NULL,
  "edge_at" TIMESTAMPTZ(6) NOT NULL,
  "keep_until" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ori_fact_ports_pkey" PRIMARY KEY ("edge_key"),
  CONSTRAINT "ori_fact_ports_check" CHECK ("port" BETWEEN 0 AND 65535)
);
CREATE INDEX "ori_fact_ports_keep_until_idx" ON "ori_fact_ports"("keep_until");
CREATE TRIGGER "ori_fact_ports_append_only" BEFORE UPDATE OR DELETE ON "ori_fact_ports"
  FOR EACH ROW EXECUTE FUNCTION "ori_append_only"();
COMMIT;
