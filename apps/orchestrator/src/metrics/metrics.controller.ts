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

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG, METRICS_REGISTRY } from '../infra/tokens.ts'
import { bearerTokenMatches } from './metrics.ts'

@Injectable()
export class MetricsTokenGuard implements CanActivate {
  readonly #token: string

  constructor(@Inject(CORE_CONFIG) config: CoreConfig) {
    this.#token = config.metricsToken
  }

  canActivate(context: ExecutionContext): boolean {
    const { headers } = context.switchToHttp().getRequest<{ headers: IncomingHttpHeaders }>()
    if (!bearerTokenMatches(headers.authorization, this.#token)) throw new UnauthorizedException()
    return true
  }
}

/** GET /metrics on the core port only: the MCP port is reachable from sandboxes. */
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
