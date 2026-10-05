/**
 * The most calls one tRPC request carries. The route refuses a larger batch, and the client
 * link splits its calls by the same number, so a page never hits the limit; without it one
 * request could queue hundreds of mutations on one user's row lock and the connection pool.
 */
export const MAX_BATCH_SIZE = 10
