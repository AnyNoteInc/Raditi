import { recognizeSpeech } from '@/server/speech'
import { speechDependencies } from '@/server/speech-runtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Dictation into the field of a chat (docs/plan/75-chat-input-output.md, ВВ17). */
export async function POST(request: Request): Promise<Response> {
  return recognizeSpeech(request, speechDependencies)
}
