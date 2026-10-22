import { Module } from '@nestjs/common'

import { PREVIEW_ACCESS_STORE } from './access.tokens.ts'
import { PostgresPreviewAccess } from './postgres-preview-access.ts'
import { PreviewSessions } from './preview-sessions.ts'

/**
 * Who may open a preview (Р19): the rows of previews, tickets and sessions in PostgreSQL behind
 * PreviewSessions, which the gateway asks. The store itself stays inside: a ticket is spent only
 * through PreviewSessions.enter, which keeps the session it opens.
 */
@Module({
  providers: [{ provide: PREVIEW_ACCESS_STORE, useClass: PostgresPreviewAccess }, PreviewSessions],
  exports: [PreviewSessions],
})
export class AccessModule {}
