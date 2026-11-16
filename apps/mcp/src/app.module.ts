import { Module, type DynamicModule } from '@nestjs/common'
import { DatabaseModule } from '@repo/service-runtime'

import { mcpProfilesOf, type McpConfig } from './config/config.ts'
import { McpConfigModule } from './config/config.module.ts'
import { McpHealthModule } from './health/health.module.ts'
import { InfraModule } from './infra/infra.module.ts'
import { assertMcpNestToolAuthorization } from './server/mcp-runtime.ts'
import { DocsModule } from './pages/docs.module.ts'
import { PagesModule } from './pages/pages.module.ts'
import { ScheduleModule } from './schedule/schedule.module.ts'
import { SearchModule } from './search/search.module.ts'
import { ServerModule } from './server/server.module.ts'
import { SiteInfoModule } from './site-info/site-info.module.ts'
import { SkillRelayModule } from './skill-relay/skill-relay.module.ts'
import { WebModule } from './web/web.module.ts'

/**
 * The mcp role on its own port: the only orchestrator port sandboxes reach (through
 * sandbox-gw), so nothing of core — /metrics, queues, workers — is mounted here.
 * In production it has its own Vault AppRole; PostgreSQL uses the shared user raditi.
 *
 * Every composition serves site_info. The cloud browser of a chat (web_*, WebModule,
 * docs/plan/57-browser-tasks.md, Б20) is there wherever the browser worker is configured
 * (BROWSER_WORKER_URL). The web search (search_web, SearchModule) is offered while its access is
 * in Vault (`subs/search/yandex`). The pages of the workspace (page_*, PagesModule,
 * docs/plan/69-pages.md) — where PAGES_BASE_DOMAIN is set; its documents (doc_*, DocsModule) and
 * the scheduled tasks of the chat's author (schedule_*, ScheduleModule,
 * docs/plan/82-scheduled-tasks.md) — always. The modules come in this order — site_info, web,
 * search, docs, pages, schedule — and so do their tools.
 */
@Module({})
export class AppModule {
  static forRoot(config: McpConfig): DynamicModule {
    const { worker } = mcpProfilesOf(config)
    // Before Nest exists, so this refusal is main.ts's line alone; ServerModule makes the
    // runtime itself.
    assertMcpNestToolAuthorization()
    return {
      module: AppModule,
      imports: [
        McpConfigModule.forRoot(config),
        DatabaseModule.forRoot(config.db),
        InfraModule,
        McpHealthModule,
        ServerModule,
        SkillRelayModule,
        SiteInfoModule,
        ...(worker ? [WebModule] : []),
        SearchModule,
        DocsModule,
        ...(config.pages ? [PagesModule] : []),
        ScheduleModule,
      ],
    }
  }
}
