-- Existing accounts keep their profile and can add a surname later.
ALTER TABLE "users" ADD COLUMN "last_name" VARCHAR(255);
