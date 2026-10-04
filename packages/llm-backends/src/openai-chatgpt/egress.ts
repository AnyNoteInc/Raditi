import type { LlmEgressOrigin } from '@repo/domain'

const backend = 'https://chatgpt.com'
const auth = 'https://auth.openai.com'

/** Every URL this adapter sends a request to; its builders use these and nothing else. */
export const codexUrls = {
  responses: `${backend}/backend-api/codex/responses`,
  usage: `${backend}/backend-api/wham/usage`,
  token: `${auth}/oauth/token`,
  revoke: `${auth}/oauth/revoke`,
  deviceCode: `${auth}/api/accounts/deviceauth/usercode`,
  deviceToken: `${auth}/api/accounts/deviceauth/token`,
} as const

export const codexEgress: readonly LlmEgressOrigin[] = [
  {
    origin: backend,
    overrideEnv: 'LLM_BACKEND_URL_OPENAI_CHATGPT',
    requests: [`POST ${codexUrls.responses}`, `GET ${codexUrls.usage}`],
  },
  {
    origin: auth,
    overrideEnv: 'LLM_AUTH_URL_OPENAI',
    requests: [
      `POST ${codexUrls.token}`,
      `POST ${codexUrls.revoke}`,
      `POST ${codexUrls.deviceCode}`,
      `POST ${codexUrls.deviceToken}`,
    ],
  },
]
