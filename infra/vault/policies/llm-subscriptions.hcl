# A gateway can read existing credentials and rotate them with CAS.
path "subs/data/*" {
  capabilities = ["read", "update"]
}
