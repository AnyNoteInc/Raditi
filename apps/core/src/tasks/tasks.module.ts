import { Module, type DynamicModule } from '@nestjs/common'

import { BrowserModule } from '../browser/browser.module.ts'
import { DriversModule } from '../drivers/drivers.module.ts'
import { GitWorkspaceModule } from '../git-workspace/git-workspace.module.ts'
import { LeasesModule } from '../leases/leases.module.ts'
import { SiteContentModule } from '../site-content/site-content.module.ts'
import { taskProviders } from './tasks.providers.ts'

/**
 * Dialogs of the core role (docs/plan/53-chat-preview-release.md, R3; roadmap N11/N12): the
 * processor of the `agent-turns` queue, the settlement of a pass with its feed rows, candidate
 * and credits, «Обновить» of a candidate and the sweep of dialogs, over the turn engine of the
 * process. Without git (CoreConfig.git is null) core starts, and every pass of a task with a
 * repository fails `unavailable` with its reserve given back (spec §20 «Транспорт git»); tasks
 * without one — in the cloud browser — run, and are recovered, all the same
 * (docs/plan/57-browser-tasks.md, Б7).
 */
@Module({
  imports: [GitWorkspaceModule, DriversModule, LeasesModule, SiteContentModule, BrowserModule],
  providers: taskProviders,
})
export class TasksModule {
  /** With the turn engine AppModule built (TurnsModule.forRoot): that same object, not another. */
  static forRoot(turns: DynamicModule): DynamicModule {
    return { module: TasksModule, imports: [turns] }
  }
}
