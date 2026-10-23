// Nest DI tokens of the connections of the core role. Ports and adapters are plain objects, so
// they are provided by Symbol tokens and injected with an explicit @Inject(TOKEN) (no reliance on
// emitted type metadata). PRISMA and SECRET_STORE are @repo/service-runtime's; the tokens of a
// feature are in its own <feature>.tokens.ts.

/** ioredis client for health checks and pub/sub; BullMQ keeps its own connections. */
export const REDIS = Symbol('REDIS')
/** ObjectStorage port (S3). */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE')
