import { Module, type DynamicModule } from '@nestjs/common'
import { isProduction, type PageBrowserFactory } from '@repo/domain'
import { DatabaseModule } from '@repo/service-runtime'

import { BrowserModule } from './browser/browser.module.ts'
import { mcpProfilesOf, type McpConfig } from './config/config.ts'
import { McpConfigModule } from './config/config.module.ts'
import { ContentModule, type ContentTesting } from './content/content.module.ts'
import { McpHealthModule } from './health/health.module.ts'
import { InfraModule } from './infra/infra.module.ts'
import { assertMcpNestToolAuthorization } from './server/mcp-runtime.ts'
import { ServerModule } from './server/server.module.ts'
import { SiteInfoModule } from './site-info/site-info.module.ts'
import { StorageModule } from './storage/storage.module.ts'
import { WebModule } from './web/web.module.ts'

/**
 * A seam for the stands, never for the regular role: wraps the gateway resolvers of the content
 * profile to inject faults (a lost acknowledgement, a refused write) and stands a browser in for
 * the browser profile. It turns nothing on: the profiles, their S3 and where a site's or a
 * preview's access comes from are the configuration's.
 */
export interface McpContentTesting extends ContentTesting {
  browserFactory?: PageBrowserFactory
}

/**
 * The mcp role on its own port: the only orchestrator port sandboxes reach (through
 * sandbox-gw), so nothing of core — /metrics, queues, workers — is mounted here.
 * In production it has its own Vault AppRole; PostgreSQL uses the shared user raditi.
 *
 * Every composition serves site_info; the content profile (MCP_CONTENT_PROFILE, ContentModule)
 * adds published content and the browser profile (MCP_BROWSER_PROFILE, BrowserModule) the
 * agent's browser on the preview, both over the one artifacts bucket (StorageModule).
 *
 * The cloud browser of a browser task (web_*, WebModule, docs/plan/57-browser-tasks.md, Б20) is
 * no profile: a product path wherever the browser worker is configured (BROWSER_WORKER_URL),
 * production too. The role passes the agent's actions to the worker; the worker holds the
 * browser. The modules of the tools come in this order — site_info, content, browser, web — and
 * so do their tools.
 */
@Module({})
export class AppModule {
  static forRoot(config: McpConfig, testing?: McpContentTesting): DynamicModule {
    const { content, siteContent, browser, previews, worker } = mcpProfilesOf(config)
    // Customer onboarding and the gate for real data are not in place (spec §20). loadConfig
    // refuses the settings in production; this refuses a composition that got past it.
    if ((content || testing) && isProduction(config.appEnv))
      throw new Error('Local MCP content profile cannot run in production')
    if (browser && isProduction(config.appEnv))
      throw new Error('Local MCP browser profile cannot run in production')
    if ((testing?.wrapResolver || testing?.wrapPreviewResolver) && !content)
      throw new Error('MCP content test seams need the content profile')
    if (testing?.browserFactory && !browser)
      throw new Error('MCP browser test seams need the browser profile')
    // The browser goes to the preview of a dialog: without previews there is nowhere to go.
    if (browser && !previews)
      throw new Error('MCP browser profile needs previews (PREVIEW_BASE_DOMAIN)')
    // loadConfig refuses both; this refuses a composition that got past it.
    if (config.contentProfile === 'local' && !previews)
      throw new Error('MCP content profile local writes into previews (PREVIEW_BASE_DOMAIN)')
    if (siteContent && previews)
      throw new Error('MCP content profile local-site is refused beside previews')
    if (content && !config.storage) throw new Error('MCP content profile needs its S3 settings')
    if (browser && !config.storage) throw new Error('MCP browser profile needs its S3 settings')
    // Before Nest exists, so this refusal is main.ts's line alone; ServerModule makes the
    // runtime itself.
    assertMcpNestToolAuthorization()
    return {
      module: AppModule,
      imports: [
        McpConfigModule.forRoot(config),
        DatabaseModule.forRoot(config.db),
        InfraModule,
        // The modules of a profile read their settings through MCP_CONFIG; the refusals above
        // are why the settings are there whenever the module is.
        ...(content || browser ? [StorageModule] : []),
        McpHealthModule,
        ServerModule,
        SiteInfoModule,
        ...(content
          ? [
              ContentModule.forRoot({
                wrapResolver: testing?.wrapResolver,
                wrapPreviewResolver: testing?.wrapPreviewResolver,
              }),
            ]
          : []),
        ...(browser ? [BrowserModule.forRoot({ browserFactory: testing?.browserFactory })] : []),
        ...(worker ? [WebModule] : []),
      ],
    }
  }
}
