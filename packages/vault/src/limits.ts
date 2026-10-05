/** Transport budgets are independent of KV's client-side page size. */
export const vaultHttpLimits = Object.freeze({
  requestBytes: 64 * 1024,
  responseBytes: 64 * 1024,
  // A read includes data and custom metadata (each written in a <=64 KiB request).
  // Go JSON escaping can expand their strings up to sixfold; leave room for the envelope.
  kvResponseBytes: 1024 * 1024,
  // KV v2 LIST returns the entire prefix before the adapter applies limit/after.
  listResponseBytes: 16 * 1024 * 1024,
})
