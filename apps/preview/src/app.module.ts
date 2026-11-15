import { Module, type DynamicModule } from '@nestjs/common'
import { DatabaseModule } from '@repo/service-runtime'

import { BrowserStreamModule } from './browser-stream/browser-stream.module.ts'
import { PreviewConfigModule } from './config/config.module.ts'
import type { PreviewConfig } from './config/config.ts'
import { PagesModule } from './pages/pages.module.ts'

/**
 * The preview app: a trusted process with the database. startPreview opens, when the browser
 * worker is configured, BrowserStreamListener on BROWSER_STREAM_PORT
 * (docs/plan/57-browser-tasks.md, Б12) and, with PAGES_BASE_DOMAIN, PagesServer on PAGES_PORT
 * (docs/plan/69-pages.md, Ст4). The gateway of previews is gone with the projects
 * (docs/plan/83-remove-projects.md, БП2). The database module is global, so Nest closes its pool
 * after the listeners have closed.
 */
@Module({})
export class AppModule {
  static forRoot(config: PreviewConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PreviewConfigModule.forRoot(config),
        DatabaseModule.forRoot(config.db),
        // The modules read their settings through PREVIEW_CONFIG; they are there whenever it is.
        ...(config.browserStream === null ? [] : [BrowserStreamModule]),
        ...(config.pages === null ? [] : [PagesModule]),
      ],
    }
  }
}
