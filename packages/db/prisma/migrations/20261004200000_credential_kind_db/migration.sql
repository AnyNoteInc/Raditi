-- A value added to an enum cannot be used in the transaction that adds it (55P04): this
-- migration holds nothing else. The CHECK that names the value is in the next one.
ALTER TYPE "CredentialKind" ADD VALUE 'db';
