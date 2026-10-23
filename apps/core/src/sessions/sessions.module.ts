import { Module } from '@nestjs/common'
import type { ObjectStorage, SecretStore } from '@repo/domain'
import { SECRET_STORE } from '@repo/service-runtime'

import { OBJECT_STORAGE } from '../infra/infra.tokens.ts'
import { SnapshotService } from './snapshot.service.ts'

/** Host-only service; P2 supplies the sandbox and site lease when executing a turn. */
@Module({
  providers: [
    {
      provide: SnapshotService,
      useFactory: (storage: ObjectStorage, secrets: SecretStore) =>
        new SnapshotService(storage, secrets),
      inject: [OBJECT_STORAGE, SECRET_STORE],
    },
  ],
  exports: [SnapshotService],
})
export class SessionsModule {}
