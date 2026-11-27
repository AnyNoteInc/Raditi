import { Logger, Module } from '@nestjs/common'
import {
  admitInWindow,
  servedContent,
  servedFile,
  servedSite,
  servedTree,
  verifyPagePassword,
  type PrismaClient,
} from '@repo/db'
import { PRISMA } from '@repo/service-runtime/tokens'

import { PREVIEW_CONFIG, type PreviewConfig } from '../config/config.tokens.ts'
import { PagesServer, type PagesStore } from './pages-server.ts'

/**
 * The store of the page server: the page without its bytes, then the bytes of the version it
 * sends (plan 96, P34); the counters of the password form.
 */
export class PostgresPagesStore implements PagesStore {
  readonly #db: PrismaClient

  constructor(db: PrismaClient) {
    this.#db = db
  }

  served(slug: string, path: string) {
    return servedSite(this.#db, slug, path)
  }

  site(slug: string) {
    return servedTree(this.#db, slug)
  }

  content(pageId: string) {
    return servedContent(this.#db, pageId)
  }

  file(treeId: string, path: string, known: readonly string[]) {
    return servedFile(this.#db, treeId, path, known)
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
      useFactory: (config: PreviewConfig, prisma: PrismaClient) => {
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
