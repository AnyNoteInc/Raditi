import { Module, type DynamicModule } from '@nestjs/common'

import { GitWorkspaceModule } from '../git-workspace/git-workspace.module.ts'
import { LlmModule } from '../llm/llm.module.ts'
import { SiteContentModule } from '../site-content/site-content.module.ts'
import { previewProviders } from './previews.providers.ts'
import { PreviewsProcessor } from './previews.processor.ts'

/**
 * Previews of dialogs in the core role (docs/plan/53-chat-preview-release.md, R5c): the
 * processor of the `previews` queue, the loop of request rows of the mcp role, the sweep. Without
 * previews here (PREVIEW_BASE_DOMAIN unset) nothing of it runs; with PREVIEW_EXECUTOR=runner
 * (M10) builds end `failed` with `not_configured` until the runner executor exists.
 */
@Module({
  imports: [GitWorkspaceModule, LlmModule, SiteContentModule],
  providers: [...previewProviders, PreviewsProcessor],
})
export class PreviewsModule {
  /** With the turn engine AppModule built (TurnsModule.forRoot): that same object, not another. */
  static forRoot(turns: DynamicModule): DynamicModule {
    return { module: PreviewsModule, imports: [turns] }
  }
}
