-- Three more stacks of a site (docs/plan/62-site-stacks.md, §2.6): Joomla, MODX and OpenCart. The
-- domain lists them in the same order (`siteStacks`). No row is changed.
--
-- Alone in its migration: PostgreSQL refuses to use a new enum value in the transaction that
-- added it.
ALTER TYPE "SiteStack" ADD VALUE 'joomla';
ALTER TYPE "SiteStack" ADD VALUE 'modx';
ALTER TYPE "SiteStack" ADD VALUE 'opencart';
