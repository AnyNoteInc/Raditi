import {
  Controller,
  Get,
  Header,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Optional,
} from '@nestjs/common'

import { HEALTH_CHECKS } from '../infra/tokens.ts'
import { bearerTokenMatches } from '../metrics/metrics.ts'
import { runHealthChecks, type HealthChecks, type HealthReport } from './health-checks.ts'

/** Only roles with an operator endpoint provide this token; MCP exposes status only. */
export const HEALTH_DETAILS_TOKEN = Symbol('HEALTH_DETAILS_TOKEN')

type HealthResponse = HealthReport | Pick<HealthReport, 'status'>

/** Shared by the core and mcp roles; each provides its own HEALTH_CHECKS. */
@Controller('health')
export class HealthController {
  readonly #checks: HealthChecks
  readonly #token: string | undefined

  constructor(
    @Inject(HEALTH_CHECKS) checks: HealthChecks,
    @Optional() @Inject(HEALTH_DETAILS_TOKEN) token?: string,
  ) {
    this.#checks = checks
    this.#token = token
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async health(@Headers('authorization') authorization?: string): Promise<HealthResponse> {
    const report = await runHealthChecks(this.#checks)
    const detailed = this.#token !== undefined && bearerTokenMatches(authorization, this.#token)
    const response = detailed ? report : { status: report.status }
    if (report.status !== 'ok') throw new HttpException(response, HttpStatus.SERVICE_UNAVAILABLE)
    return response
  }
}
