# The keys of the VK communities of a workspace (docs/plan/99-vk-community.md, §3.3, rule 4): web
# writes them from the form and never reads them back; core reads one for a publication the client
# pressed on its card, and for nothing else. It never writes one nor reads metadata.
path "kv/data/workspaces/+/vk/*" {
  capabilities = ["read"]
}
