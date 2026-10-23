import { Module } from '@nestjs/common'
import type { SecretStore } from '@repo/domain'
import { SECRET_STORE } from '@repo/service-runtime'

import { ContentPrivacy } from './content-privacy.ts'
import { CONTENT_PRIVACY } from './privacy.tokens.ts'

/**
 * What the agent may not see of a page: contacts become opaque markers, their map stays in
 * Vault (`kv/content-masks/…`). Stateless: content and the browser share the one instance.
 */
@Module({
  providers: [
    {
      provide: CONTENT_PRIVACY,
      inject: [SECRET_STORE],
      useFactory: (secrets: SecretStore) => new ContentPrivacy(secrets),
    },
  ],
  exports: [CONTENT_PRIVACY],
})
export class PrivacyModule {}
