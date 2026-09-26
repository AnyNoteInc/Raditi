import './load-env.ts'
import 'reflect-metadata'

import { Logger } from '@nestjs/common'
import { isDomainError } from '@repo/domain'

import { errorMessage } from './common/async.ts'
import { ConfigError, loadConfig } from './config/config.ts'
import { startRoles } from './roles.ts'

try {
  await startRoles(loadConfig(process.env))
} catch (err) {
  const logger = new Logger('Orchestrator')
  // Configuration problems and "not implemented" speak for themselves; anything else gets a stack.
  if (err instanceof ConfigError || isDomainError(err) || !(err instanceof Error)) {
    logger.error(errorMessage(err))
  } else {
    logger.error(errorMessage(err), err.stack)
  }
  process.exit(1)
}
