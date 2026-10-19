# The access the wizard stored for a site: FTP, SFTP, the client's repository and the database.
# Read-only, without the WordPress and browser kinds. The grant covers every site; each reader in
# core narrows it to its own site and reads the version its credential_refs row names (spec §15):
# the initial import — a site in onboarding whose code_import stage it holds; the previews — the
# site of their dialog (the database copy and the configuration, previews/site-sources.ts); the
# release API — the site of a release with an attempt in work (the access of its deploy job).
path "kv/data/sites/+/ftp" {
  capabilities = ["read"]
}

path "kv/data/sites/+/ssh" {
  capabilities = ["read"]
}

path "kv/data/sites/+/git" {
  capabilities = ["read"]
}

path "kv/data/sites/+/db" {
  capabilities = ["read"]
}
