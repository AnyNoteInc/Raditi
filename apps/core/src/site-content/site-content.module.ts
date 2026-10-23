import { Module } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import type { HostLookup, ObjectStorage, SecretStore } from '@repo/domain'
import { createHostLookup } from '@repo/site-connections/hosting'
import { PreviewDbValueStorage } from '@repo/site-content'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'

import type { CoreConfig } from '../config/config.ts'
import { CORE_CONFIG } from '../config/config.tokens.ts'
import { OBJECT_STORAGE } from '../infra/infra.tokens.ts'
import { previewDbPlanValues } from './db-plan-values.ts'
import { siteContentResolvers } from './site-content-access.ts'
import { HOST_LOOKUP, PLAN_VALUES, SITE_CONTENT_RESOLVERS } from './site-content.tokens.ts'

/**
 * What core reads of a site's content and of its database plan (docs/plan/53-chat-preview-
 * release.md, R5c, R7, R8b): the values the agent wrote into a preview, DNS of a site's address
 * and the resolver of a site's production content gateway — a new one for each consumer. None of
 * them holds a connection.
 */
@Module({
  providers: [
    {
      provide: PLAN_VALUES,
      useFactory: (prisma: PrismaClient, storage: ObjectStorage, secrets: SecretStore) =>
        previewDbPlanValues({ prisma, values: new PreviewDbValueStorage(storage, secrets) }),
      inject: [PRISMA, OBJECT_STORAGE, SECRET_STORE],
    },
    { provide: HOST_LOOKUP, useFactory: (): HostLookup => createHostLookup() },
    {
      provide: SITE_CONTENT_RESOLVERS,
      useFactory: (
        prisma: PrismaClient,
        secrets: SecretStore,
        lookup: HostLookup,
        config: CoreConfig,
      ) => siteContentResolvers({ prisma, secrets, lookup, appEnv: config.appEnv }),
      inject: [PRISMA, SECRET_STORE, HOST_LOOKUP, CORE_CONFIG],
    },
  ],
  exports: [PLAN_VALUES, HOST_LOOKUP, SITE_CONTENT_RESOLVERS],
})
export class SiteContentModule {}
