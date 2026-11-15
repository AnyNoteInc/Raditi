import { TRPCClientError } from '@trpc/client'
import { describe, expect, it } from 'vitest'

import { messageOf } from './page-actions'

describe('messageOf', () => {
  it('says the server’s words for a refusal of the domain, «try again» for anything else', () => {
    const refusal = new TRPCClientError('Сначала верните страницу, в которую вложена эта', {
      result: {
        error: {
          code: -32603,
          message: 'Сначала верните страницу, в которую вложена эта',
          data: { domainCode: 'PAGE_PARENT_DELETED' },
        },
      },
    } as never)
    expect(messageOf(refusal)).toBe('Сначала верните страницу, в которую вложена эта')
    expect(messageOf(new TypeError('Failed to fetch'))).toBe('Не получилось. Попробуйте ещё раз.')
    expect(messageOf(new TRPCClientError('fetch failed'))).toBe(
      'Не получилось. Попробуйте ещё раз.',
    )
  })
})
