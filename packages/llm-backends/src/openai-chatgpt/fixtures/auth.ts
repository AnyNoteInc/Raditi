// Entirely synthetic JWTs. The signatures are placeholders, never accepted by a provider.
export const syntheticJwt = (claims: Record<string, unknown>): string =>
  `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic-signature`

export const syntheticCodexCredential = (patch: Record<string, unknown> = {}) => ({
  v: '1' as const,
  kind: 'chatgpt_oauth' as const,
  accessToken: syntheticJwt({ iat: 1_790_726_400, exp: 1_790_730_000 }),
  refreshToken: 'synthetic-refresh-token',
  idToken: syntheticJwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'synthetic-account',
      chatgpt_plan_type: 'plus',
    },
  }),
  chatgptAccountId: 'synthetic-account',
  accessExpiresAt: new Date(1_790_730_000_000).toISOString(),
  refreshedAt: new Date(1_790_726_400_000).toISOString(),
  ...patch,
})
