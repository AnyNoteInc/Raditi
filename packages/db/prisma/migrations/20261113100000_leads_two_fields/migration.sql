-- The lead of the landing shrinks to two fields (owner, 13.11.2026): the site and a contact, which
-- is a phone number or a Telegram username. The name, the mail and the description stay with the
-- rows written before and are NULL from now on; `phone` keeps its name and takes `@name` too.
BEGIN;

ALTER TABLE "leads" ALTER COLUMN "name" DROP NOT NULL;
ALTER TABLE "leads" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "leads" ALTER COLUMN "about" DROP NOT NULL;
ALTER TABLE "leads" ALTER COLUMN "phone" SET DATA TYPE VARCHAR(34);

ALTER TABLE "leads" DROP CONSTRAINT "leads_phone_check";
ALTER TABLE "leads" ADD CONSTRAINT "leads_phone_check"
    CHECK ("phone" ~ '^(\+[0-9]{10,15}|@[a-z][a-z0-9_]{4,31})$');

ALTER TABLE "leads" DROP CONSTRAINT "leads_about_check";
ALTER TABLE "leads" ADD CONSTRAINT "leads_about_check"
    CHECK ("about" IS NULL OR char_length("about") BETWEEN 10 AND 2000);

COMMIT;
