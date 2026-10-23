import '@repo/app-bootstrap/load-env'
import 'reflect-metadata'

import { Logger } from '@nestjs/common'
import { isDomainError } from '@repo/domain'
import { errorMessage } from '@repo/observability'
import { armShutdownTimeout } from '@repo/app-bootstrap'

import { ConfigError, loadPreviewConfig } from './config/config.ts'
import { startPreview } from './start.ts'

const logger = new Logger('preview')

try {
  await startPreview(loadPreviewConfig(process.env))
  armShutdownTimeout(logger)
} catch (err) {
  // Configuration problems and "not implemented" speak for themselves; anything else gets a stack.
  if (err instanceof ConfigError || isDomainError(err) || !(err instanceof Error)) {
    logger.error(errorMessage(err))
  } else {
    logger.error(errorMessage(err), err.stack)
  }
  process.exit(1)
}
