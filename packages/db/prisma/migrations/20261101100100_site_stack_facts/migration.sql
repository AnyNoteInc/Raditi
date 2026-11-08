-- What the platform knows of a site (docs/plan/62-site-stacks.md, Т13): one record written in
-- parts, `stack_facts || $1`, and read through `siteStackFactsOf` of the domain. Every site there
-- is gets the empty object, which reads as nothing known yet; NOT NULL keeps `||` from giving NULL.
--
-- One statement: the column and its check apply together.
ALTER TABLE "sites"
  ADD COLUMN "stack_facts" JSONB NOT NULL DEFAULT '{}',
  ADD CONSTRAINT "sites_stack_facts_check" CHECK (
    jsonb_typeof("stack_facts") = 'object' AND octet_length("stack_facts"::text) <= 4096
  );
