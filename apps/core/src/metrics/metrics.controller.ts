import type { IncomingHttpHeaders } from 'node:http'

import {
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { Registry } from '@prometheus-io/client'
import { bearerTokenMatches } from '@repo/observability'

import { METRICS_REGISTRY, METRICS_TOKEN } from './metrics.tokens.ts'

@Injectable()
export class MetricsTokenGuard implements CanActivate {
  readonly #token: string

  constructor(@Inject(METRICS_TOKEN) token: string) {
    this.#token = token
  }

  canActivate(context: ExecutionContext): boolean {
    const { headers } = context.switchToHttp().getRequest<{ headers: IncomingHttpHeaders }>()
    if (!bearerTokenMatches(headers.authorization, this.#token)) throw new UnauthorizedException()
    return true
  }
}

/**
 * GET /metrics, on the core port only: the MCP port is reachable from sandboxes. MetricsModule
 * provides METRICS_TOKEN and MetricsTokenGuard beside this controller.
 */
@Controller('metrics')
@UseGuards(MetricsTokenGuard)
export class MetricsController {
  readonly #registry: Registry

  constructor(@Inject(METRICS_REGISTRY) registry: Registry) {
    this.#registry = registry
  }

  @Get()
  @Header('Content-Type', Registry.PROMETHEUS_CONTENT_TYPE)
  @Header('Cache-Control', 'no-store')
  metrics(): Promise<string> {
    return this.#registry.metrics()
  }
}
