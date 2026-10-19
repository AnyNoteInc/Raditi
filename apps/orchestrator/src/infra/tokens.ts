// Nest DI tokens. Ports and adapters are plain objects, so they are provided by Symbol tokens
// and injected with an explicit @Inject(TOKEN) (no reliance on emitted type metadata).

/** CoreConfig of this process. */
export const CORE_CONFIG = Symbol('CORE_CONFIG')
/** PreviewGatewayConfig of the `preview` role. */
export const PREVIEW_GATEWAY_CONFIG = Symbol('PREVIEW_GATEWAY_CONFIG')
/** false in tests and tools: no BullMQ workers, no polling loops. */
export const BACKGROUND_JOBS = Symbol('BACKGROUND_JOBS')

/** PrismaClient from @repo/db. */
export const PRISMA = Symbol('PRISMA')
/** ObjectStorage port (S3). */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE')
/** SecretStore port (Vault/OpenBao). */
export const SECRET_STORE = Symbol('SECRET_STORE')
/** SiteLeaseStore port (PostgreSQL). */
export const SITE_LEASES = Symbol('SITE_LEASES')
/** TurnAssignmentStore port (PostgreSQL). */
export const TURN_ASSIGNMENTS = Symbol('TURN_ASSIGNMENTS')
/** TurnExecutor port: LocalTurnExecutor or the runner API, by TURN_EXECUTOR. */
export const TURN_EXECUTOR = Symbol('TURN_EXECUTOR')
/** Per-turn subscription gateway key and MCP token: Vault turns/ plus fenced PostgreSQL rows. */
export const TURN_CREDENTIALS = Symbol('TURN_CREDENTIALS')
/** SandboxProvider port (Docker in the PoC). */
export const SANDBOX_PROVIDER = Symbol('SANDBOX_PROVIDER')
/** AgentDriverRegistry of the enabled CLI agents. */
export const AGENT_DRIVERS = Symbol('AGENT_DRIVERS')
/** GitProvider port of site repositories, or null while git is not configured (CoreConfig.git). */
export const GIT_PROVIDER = Symbol('GIT_PROVIDER')
/** JobQueue port (BullMQ). */
export const JOB_QUEUE = Symbol('JOB_QUEUE')
/** ReadonlyMap<QueueName, Queue> of the BullMQ queues registered by QueueModule. */
export const BULL_QUEUES = Symbol('BULL_QUEUES')
/** ioredis client for health checks and pub/sub; BullMQ keeps its own connections. */
export const REDIS = Symbol('REDIS')

/** Record<string, HealthCheck> served by GET /health. */
export const HEALTH_CHECKS = Symbol('HEALTH_CHECKS')
/** Prometheus registry served by GET /metrics. */
export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY')
/** Mailer from @repo/mail. */
export const MAILER = Symbol('MAILER')
/** YookassaClient from @repo/yookassa, or null while payments are off (CoreConfig.yookassa). */
export const YOOKASSA = Symbol('YOOKASSA')
