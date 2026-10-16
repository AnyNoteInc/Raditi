# The import of a connecting site reads the access the wizard stored: FTP, SFTP, the client's
# repository and the database. Read-only, without the WordPress and browser kinds. The grant
# covers every site: the reader in core narrows it to a site that is being connected.
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
