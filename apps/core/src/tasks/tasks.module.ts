import { Module, type DynamicModule } from '@nestjs/common'

import { BrowserModule } from '../browser/browser.module.ts'
import { DriversModule } from '../drivers/drivers.module.ts'
import { LeasesModule } from '../leases/leases.module.ts'
import { GitModule } from '../git/git.module.ts'
import { GitWorkspaceModule } from '../git-workspace/git-workspace.module.ts'
import { taskProviders } from './tasks.providers.ts'

/**
 * Chats of the core role (roadmap N11/N12): the processor of the `agent-turns` queue, the
 * settlement of a pass with its feed rows and credits, and the sweep of chats, over the turn
 * engine of the process. A chat has no site and no repository (docs/plan/83-remove-projects.md).
 */
@Module({
  // GitModule and GitWorkspaceModule: the repository of a pass (docs/plan/84-projects.md, ПР12).
  imports: [DriversModule, LeasesModule, BrowserModule, GitModule, GitWorkspaceModule],
  providers: taskProviders,
})
export class TasksModule {
  /** With the turn engine AppModule built (TurnsModule.forRoot): that same object, not another. */
  static forRoot(turns: DynamicModule): DynamicModule {
    return { module: TasksModule, imports: [turns] }
  }
}
