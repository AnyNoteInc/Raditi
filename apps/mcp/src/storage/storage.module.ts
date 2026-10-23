import { Global, Module } from '@nestjs/common'

import type { McpConfig } from '../config/config.ts'
import { MCP_CONFIG } from '../config/config.module.ts'
import {
  createContentStorage,
  MCP_CONTENT_STORAGE,
  type ContentStorage,
} from './content-storage.ts'

/**
 * The one S3 bucket of the role (artifacts): the snapshots of the content profile and the
 * screenshots of the browser profile. AppModule imports it only with a profile on and refuses a
 * profile without the S3 settings, so the settings are there whenever this module is.
 */
@Global()
@Module({
  providers: [
    {
      provide: MCP_CONTENT_STORAGE,
      inject: [MCP_CONFIG],
      useFactory: (config: McpConfig): ContentStorage => {
        // AppModule refused this composition already; this narrows the type.
        if (!config.storage) throw new Error('MCP storage needs its S3 settings')
        return createContentStorage(config.storage)
      },
    },
  ],
  exports: [MCP_CONTENT_STORAGE],
})
export class StorageModule {}
