import { Module, type DynamicModule } from '@nestjs/common'
import { createPlaywrightBrowserFactory } from '@repo/browser-providers'
import type { PrismaClient } from '@repo/db'
import type { PageBrowserFactory, SecretStore } from '@repo/domain'
import { getSiteAdapter } from '@repo/site-adapters'
import { PRISMA, SECRET_STORE } from '@repo/service-runtime'

import { mcpProfilesOf, type McpConfig } from '../config/config.ts'
import { MCP_CONFIG } from '../config/config.module.ts'
import type { ContentPrivacy } from '../privacy/content-privacy.ts'
import { PrivacyModule } from '../privacy/privacy.module.ts'
import { CONTENT_PRIVACY } from '../privacy/privacy.tokens.ts'
import { MCP_CONTENT_STORAGE, type ContentStorage } from '../storage/content-storage.ts'
import { McpBrowserController } from './mcp-browser.controller.ts'
import { MCP_BROWSER, McpBrowserService } from './mcp-browser.ts'
import { PostgresMcpBrowserStore } from './mcp-browser-store.ts'

/** The seam of the browser profile a stand may use. */
export interface BrowserTesting {
  /** A stand's browser in place of Playwright (the regular role never passes one). */
  browserFactory?: PageBrowserFactory
}

/**
 * The agent's browser on the preview (browser_*) — the browser profile of the configuration
 * (MCP_BROWSER_PROFILE, Р21): a context of the preview's browser per turn, screenshots in the
 * artifacts bucket. It goes to the preview of a dialog, never elsewhere: AppModule imports it
 * only with previews configured.
 */
@Module({})
export class BrowserModule {
  static forRoot({ browserFactory }: BrowserTesting = {}): DynamicModule {
    return {
      module: BrowserModule,
      imports: [PrivacyModule],
      controllers: [McpBrowserController],
      providers: [
        {
          provide: MCP_BROWSER,
          inject: [MCP_CONFIG, PRISMA, MCP_CONTENT_STORAGE, SECRET_STORE, CONTENT_PRIVACY],
          useFactory: (
            config: McpConfig,
            prisma: PrismaClient,
            storage: ContentStorage,
            secrets: SecretStore,
            privacy: ContentPrivacy,
          ) => {
            const address = mcpProfilesOf(config).previews
            // AppModule refused this composition already; this narrows the type.
            if (!address)
              throw new Error('MCP browser profile needs previews (PREVIEW_BASE_DOMAIN)')
            return new McpBrowserService({
              store: new PostgresMcpBrowserStore(prisma),
              factory: browserFactory ?? createPlaywrightBrowserFactory(),
              secrets,
              privacy,
              storage,
              // The stack of the site picks where its pages may go; this module names no CMS.
              adapters: getSiteAdapter,
              address,
            })
          },
        },
      ],
    }
  }
}
