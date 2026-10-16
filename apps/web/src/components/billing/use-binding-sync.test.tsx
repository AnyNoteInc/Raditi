// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BillingOverview, MethodBinding } from './billing-types'
import { overviewOf, serverRefusal, subscriptionTo } from './testing'
import { useBindingSync } from './use-binding-sync'

const { syncPaymentMethod, trpc } = vi.hoisted(() => ({
  syncPaymentMethod: vi.fn<(input: Record<string, never>) => Promise<MethodBinding>>(),
  // One object for every render, as the real context gives.
  trpc: {
    billing: {
      overview: { queryKey: () => ['billing', 'overview'] },
      plans: { queryKey: () => ['billing', 'plans'] },
    },
  },
}))

vi.mock('@/trpc/client', () => ({
  useTRPC: () => trpc,
  useTRPCClient: () => ({ billing: { syncPaymentMethod: { mutate: syncPaymentMethod } } }),
}))

const binding = (state: MethodBinding['state']): MethodBinding => ({
  state,
  renewalCharge: 'none',
  subscription: subscriptionTo(),
})
/** The overview of a customer whose tariff waits for a binding, unless told otherwise. */
const waiting = (patch: Partial<BillingOverview> = {}) =>
  overviewOf({ subscription: subscriptionTo(), bindingPending: true, ...patch })

type Overview = Parameters<typeof useBindingSync>[0]

/** A page that shows the payment method, with the overview it has read so far. */
function openPage(overview: Overview, { strict = false } = {}) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['billing', 'overview'], overview ?? null)
  queryClient.setQueryData(['billing', 'plans'], { plans: [] })
  const page = renderHook(({ shown }: { shown: Overview }) => useBindingSync(shown), {
    initialProps: { shown: overview },
    wrapper: ({ children }: { children: ReactNode }) => {
      const tree = <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      return strict ? <StrictMode>{tree}</StrictMode> : tree
    },
  })
  const invalidated = (key: string) =>
    queryClient.getQueryState(['billing', key])?.isInvalidated === true
  return { ...page, invalidated }
}

/** Long enough for an answer that is on its way to be acted on. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)))

beforeEach(() => {
  vi.clearAllMocks()
  syncPaymentMethod.mockResolvedValue(binding('active'))
})

describe('settling a binding that waits', () => {
  it('asks once when the overview says that a binding waits, and names nothing in the request', async () => {
    const page = openPage(waiting())

    await waitFor(() => expect(page.invalidated('overview')).toBe(true))

    // The server knows whose binding it is.
    expect(syncPaymentMethod.mock.calls).toEqual([[{}]])
    // What a binding does not change is left alone.
    expect(page.invalidated('plans')).toBe(false)
  })

  it.each(['active', 'inactive', 'none'] as const)(
    'has the overview read anew once the binding is %s',
    async (state) => {
      syncPaymentMethod.mockResolvedValue(binding(state))
      const page = openPage(waiting())

      await waitFor(() => expect(page.invalidated('overview')).toBe(true))
      expect(syncPaymentMethod).toHaveBeenCalledTimes(1)
    },
  )

  it('reads nothing anew while the binding has no outcome, and does not ask again', async () => {
    syncPaymentMethod.mockResolvedValue(binding('pending'))
    const page = openPage(waiting())
    await settle()

    expect(page.invalidated('overview')).toBe(false)
    // The overview comes again, as a new object that says the same: no second look.
    for (let reading = 0; reading < 3; reading += 1) {
      page.rerender({ shown: waiting() })
      await settle()
    }
    expect(syncPaymentMethod).toHaveBeenCalledTimes(1)
  })

  it('does not ask again when the overview still says «waits» after an outcome', async () => {
    const page = openPage(waiting())
    await waitFor(() => expect(page.invalidated('overview')).toBe(true))

    // A reading that raced the look, or a new binding started in another tab.
    page.rerender({ shown: waiting() })
    page.rerender({ shown: overviewOf({ subscription: subscriptionTo() }) })
    page.rerender({ shown: waiting() })
    await settle()

    expect(syncPaymentMethod).toHaveBeenCalledTimes(1)
  })

  it('asks once under the double effects of development', async () => {
    const page = openPage(waiting(), { strict: true })

    await waitFor(() => expect(page.invalidated('overview')).toBe(true))
    await settle()

    expect(syncPaymentMethod).toHaveBeenCalledTimes(1)
  })

  it('asks when the overview arrives after the page was opened', async () => {
    const page = openPage(undefined)
    await settle()
    expect(syncPaymentMethod).not.toHaveBeenCalled()

    page.rerender({ shown: waiting() })

    await waitFor(() => expect(syncPaymentMethod).toHaveBeenCalledTimes(1))
  })
})

describe('a page with nothing to settle', () => {
  it.each([
    ['no overview has been read yet', undefined],
    ['there is no tariff', overviewOf()],
    ['no binding waits', overviewOf({ subscription: subscriptionTo() })],
    // Without the shop the procedure refuses: nobody could read the method back.
    ['payments are off', waiting({ paymentsEnabled: false })],
  ])('asks nothing when %s', async (_case, overview) => {
    const page = openPage(overview)
    await settle()

    expect(syncPaymentMethod).not.toHaveBeenCalled()
    expect(page.invalidated('overview')).toBe(false)
  })
})

describe('a look that fails', () => {
  it.each([
    ['does not reach the server', new TypeError('Failed to fetch')],
    ['is refused', serverRefusal('Оплата сейчас недоступна', 'BILLING_PAYMENTS_NOT_CONFIGURED')],
  ])('throws nothing, changes nothing and is not repeated when it %s', async (_case, failure) => {
    syncPaymentMethod.mockRejectedValue(failure)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const page = openPage(waiting())
      await settle()
      page.rerender({ shown: waiting() })
      await settle()

      expect(syncPaymentMethod).toHaveBeenCalledTimes(1)
      // The page keeps what it has: nothing asks for a reading that would tell the same.
      expect(page.invalidated('overview')).toBe(false)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
