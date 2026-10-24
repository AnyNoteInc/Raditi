import type { IncomingHttpHeaders } from 'node:http'

import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { bearerTokenMatches } from '@repo/observability'

import { WORKER_TOKEN } from './api.tokens.ts'

/**
 * `Authorization: Bearer <BROWSER_WORKER_TOKEN>` on every call of the worker's API: core, mcp and
 * the stream gateway hold the token, nobody else. Compared in constant time; a refusal says 401
 * and nothing about why.
 */
@Injectable()
export class WorkerTokenGuard implements CanActivate {
  readonly #token: string

  constructor(@Inject(WORKER_TOKEN) token: string) {
    this.#token = token
  }

  canActivate(context: ExecutionContext): boolean {
    const { headers } = context.switchToHttp().getRequest<{ headers: IncomingHttpHeaders }>()
    if (!bearerTokenMatches(headers.authorization, this.#token)) throw new UnauthorizedException()
    return true
  }
}
