import {
  Controller,
  Get,
  Header,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common'
import {
  bearerTokenMatches,
  cachedHealthProbe,
  throttledLogger,
  type HealthChecks,
  type HealthProbe,
  type HealthReport,
} from '@repo/observability'

import { HEALTH_CHECKS } from '../infra/tokens.ts'

/** Only roles with an operator endpoint provide this token; MCP exposes status only. */
export const HEALTH_DETAILS_TOKEN = Symbol('HEALTH_DETAILS_TOKEN')

type HealthResponse = HealthReport | Pick<HealthReport, 'status'>

/**
 * Shared by the core and mcp roles; each provides its own HEALTH_CHECKS. Reports are reused
 * for a few seconds and failures are logged at most once a minute per dependency.
 */
@Controller('health')
export class HealthController {
  readonly #probe: HealthProbe
  readonly #token: string | undefined

  constructor(
    @Inject(HEALTH_CHECKS) checks: HealthChecks,
    @Optional() @Inject(HEALTH_DETAILS_TOKEN) token?: string,
  ) {
    const logger = new Logger(HealthController.name)
    const warn = throttledLogger((line) => logger.warn(line))
    this.#probe = cachedHealthProbe(checks, {
      onFailure: (name, error) => warn(`${name} is unavailable`, error),
    })
    this.#token = token
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async health(@Headers('authorization') authorization?: string): Promise<HealthResponse> {
    const report = await this.#probe()
    const detailed = this.#token !== undefined && bearerTokenMatches(authorization, this.#token)
    const response = detailed ? report : { status: report.status }
    if (report.status !== 'ok') throw new HttpException(response, HttpStatus.SERVICE_UNAVAILABLE)
    return response
  }
}
