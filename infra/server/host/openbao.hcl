# /etc/openbao/openbao.hcl on the single server (infra/server/README.md). OpenBao runs on the host,
# not in Docker: the secrets of the containers are rendered from it before docker.service starts.
# Services in containers reach it by TLS on the private address as vault.raditi.internal (the
# internal CA); the host's own operator commands and the secret renderer use loopback.
ui            = false
disable_mlock = true

storage "raft" {
  path    = "/var/lib/openbao/data"
  node_id = "raditi-1"
}

# Loopback, host processes only: the renderer of /run/raditi and the operator.
listener "tcp" {
  address     = "127.0.0.1:8200"
  tls_disable = true
}

# The private address: web, core, llm and mcp (vault.raditi.internal in their extra_hosts).
listener "tcp" {
  address       = "10.10.0.10:8200"
  tls_cert_file = "/etc/openbao/tls/vault.pem"
  tls_key_file  = "/etc/openbao/tls/vault.key"
  tls_min_version = "tls12"
}

api_addr     = "https://vault.raditi.internal:8200"
cluster_addr = "https://127.0.0.1:8201"
