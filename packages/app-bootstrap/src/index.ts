// The frame of every app process: listening and shutdown, the logger named after the app's
// container, the error of a configuration and the search for the repository .env
// (`./load-env`, the first import of each main.ts). It reaches no database, Redis, Vault or S3 —
// the runner on a sandbox VM takes this package and nothing of @repo/service-runtime.
// Decorator-free, so Node loads the sources as they are.
export * from './bootstrap.ts'
export * from './config-error.ts'
export * from './env-file.ts'
