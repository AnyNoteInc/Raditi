import { Module } from '@nestjs/common'
import type { SecretStore } from '@repo/domain'
import { SECRET_STORE } from '@repo/service-runtime'

import { ContentPrivacy } from './content-privacy.ts'
import { CONTENT_PRIVACY } from './privacy.tokens.ts'

/**
 * The contacts behind the markers pages showed the agent before 09.11.2026: their map stays in
 * Vault (`kv/content-masks/…`), and the browser gives them back when the agent types a marker.
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
