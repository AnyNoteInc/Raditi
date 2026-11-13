import { Logger, Module } from '@nestjs/common'
import { admitInWindow, servedPage, verifyPagePassword, type PrismaClient } from '@repo/db'
import { PRISMA } from '@repo/service-runtime/tokens'

import { PREVIEW_CONFIG, type PreviewGatewayConfig } from '../config/config.tokens.ts'
import { PagesServer, type PagesStore } from './pages-server.ts'

/** The store of the page server: one read of the page, the counters of the password form. */
export class PostgresPagesStore implements PagesStore {
  readonly #db: PrismaClient

  constructor(db: PrismaClient) {
    this.#db = db
  }

  served(slug: string) {
    return servedPage(this.#db, slug)
  }

  admit(key: string, limit: number, windowMs: number, now: number) {
    return admitInWindow(this.#db, { key, limit, windowMs, now })
  }

  verify(password: string, hash: string) {
    return verifyPagePassword(password, hash)
  }
}

/**
 * Published pages (docs/plan/69-pages.md, Ст4): their own listener, which startPreview opens on
 * PAGES_PORT. AppModule imports it only when PAGES_BASE_DOMAIN is set. No module injects the
 * server: startPreview takes it with app.get, its shutdown hook closes it.
 */
@Module({
  providers: [
    {
      provide: PagesServer,
      useFactory: (config: PreviewGatewayConfig, prisma: PrismaClient) => {
        if (config.pages === null) throw new Error('The pages need PAGES_BASE_DOMAIN')
        const logger = new Logger('Pages')
        return new PagesServer({
          config: config.pages,
          store: new PostgresPagesStore(prisma),
          logger: { warn: (message) => logger.warn(message) },
        })
      },
      inject: [PREVIEW_CONFIG, PRISMA],
    },
  ],
})
export class PagesModule {}
