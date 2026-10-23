import { Global, Module, type DynamicModule } from '@nestjs/common'

import type { LlmRoleConfig } from './config.ts'

/** LlmRoleConfig, parsed before Nest exists (main.ts): the one value every module reads. */
export const LLM_CONFIG = Symbol('LLM_CONFIG')

/**
 * The configuration of the role for every module of it: global, so no module imports it.
 * Called once per process (AppModule.forRoot): Nest tells dynamic modules apart by reference.
 */
@Global()
@Module({})
export class LlmConfigModule {
  static forRoot(config: LlmRoleConfig): DynamicModule {
    return {
      module: LlmConfigModule,
      providers: [{ provide: LLM_CONFIG, useValue: config }],
      exports: [LLM_CONFIG],
    }
  }
}
