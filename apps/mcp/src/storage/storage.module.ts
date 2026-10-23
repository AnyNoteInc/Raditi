import { Global, Module, type DynamicModule } from '@nestjs/common'

import type { McpStorageConfig } from '../config/config.ts'
import {
  createContentStorage,
  MCP_CONTENT_STORAGE,
  type ContentStorage,
} from './content-storage.ts'

/**
 * The one S3 bucket of the role (artifacts): the snapshots of the content profile and the
 * screenshots of the browser profile. Only with a profile on, so its settings come narrowed:
 * AppModule refuses a profile without them.
 */
@Global()
@Module({})
export class StorageModule {
  static forRoot(storage: McpStorageConfig): DynamicModule {
    return {
      module: StorageModule,
      providers: [
        {
          provide: MCP_CONTENT_STORAGE,
          useFactory: (): ContentStorage => createContentStorage(storage),
        },
      ],
      exports: [MCP_CONTENT_STORAGE],
    }
  }
}
