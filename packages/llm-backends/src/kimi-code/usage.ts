import { createChatCompletionsUsageMeter } from '../chat-completions-usage.ts'
import type { UsageMeter } from '../usage.ts'
import { createKimiStreamInspector } from './stream.ts'

/** Kimi answers with an OpenAI-style chat completions stream: the shared meter, Kimi's failures. */
export const createKimiUsageMeter = (): UsageMeter =>
  createChatCompletionsUsageMeter(createKimiStreamInspector)
