-- «Выкатить» of GitHub (docs/plan/84-projects.md, 84.25): `workflow_dispatch` is 17 characters,
-- and `project_deploy_actions.kind` took 16 — core could not keep a single workflow of a
-- repository of the GitHub App, and the card of a deploy stayed empty. The column only widens.
ALTER TABLE "project_deploy_actions" ALTER COLUMN "kind" TYPE VARCHAR(24);
