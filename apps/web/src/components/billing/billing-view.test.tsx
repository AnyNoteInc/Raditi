// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BillingOverview, MethodBinding, MethodUnlink, PaymentEntry } from './billing-types'
import { BillingView } from './billing-view'
import {
  agencyPlan,
  creditBalances,
  ONE_TIME_ONLY,
  overviewOf,
  plain,
  serverRefusal,
  subscriptionTo,
} from './testing'

interface PaymentsPage {
  items: PaymentEntry[]
  nextCursor: string | null
}
type PaymentsQuery = { cursor?: string }
type Nothing = Record<string, never>
type Started = { confirmationUrl: string }

const { getOverview, getPayments, startChange, unlinkMethod, syncMethod, hardNavigate, trpc } =
  vi.hoisted(() => {
    const getOverview = vi.fn<() => Promise<BillingOverview>>()
    const startChange = vi.fn<(input: Nothing) => Promise<Started>>()
    const unlinkMethod = vi.fn<(input: Nothing) => Promise<MethodUnlink>>()
    return {
      getOverview,
      getPayments: vi.fn<(query: PaymentsQuery) => Promise<PaymentsPage>>(),
      startChange,
      unlinkMethod,
      syncMethod: vi.fn<(input: Nothing) => Promise<MethodBinding>>(),
      hardNavigate: vi.fn<(path: string) => void>(),
      // One object for every render, as the real context gives.
      trpc: {
        billing: {
          overview: {
            queryKey: () => ['billing', 'overview'],
            queryOptions: () => ({ queryKey: ['billing', 'overview'], queryFn: getOverview }),
          },
          plans: { queryKey: () => ['billing', 'plans'] },
          usage: { queryKey: () => ['billing', 'usage'] },
          startPaymentMethodChange: {
            mutationOptions: (options: UseMutationOptions<Started, Error, Nothing>) => ({
              ...options,
              mutationFn: startChange,
            }),
          },
          unlinkPaymentMethod: {
            mutationOptions: (options: UseMutationOptions<MethodUnlink, Error, Nothing>) => ({
              ...options,
              mutationFn: unlinkMethod,
            }),
          },
        },
      },
    }
  })

vi.mock('@/lib/hard-navigate', () => ({ hardNavigate }))
vi.mock('@/trpc/client', () => ({
  useTRPC: () => trpc,
  useTRPCClient: () => ({
    billing: { payments: { query: getPayments }, syncPaymentMethod: { mutate: syncMethod } },
  }),
}))

const bindingPage = 'https://yookassa.example/bind/7a1e'

let entries = 0
/** A paid order of «Бизнес» for September–October 2026, unless told otherwise. */
function payment(patch: Partial<PaymentEntry> = {}): PaymentEntry {
  entries += 1
  return {
    id: `018f0000-0000-7000-8000-${String(entries).padStart(12, '0')}`,
    kind: 'subscription',
    planName: 'Бизнес',
    period: { start: new Date('2026-09-18T09:00:00Z'), end: new Date('2026-10-18T09:00:00Z') },
    amount: '12900.00',
    status: 'paid',
    failureReason: null,
    failureText: null,
    refundedAmount: null,
    refundedAt: null,
    paidAt: new Date('2026-09-18T09:00:05Z'),
    createdAt: new Date('2026-09-18T09:00:00Z'),
    ...patch,
  }
}
const pack = (patch: Partial<PaymentEntry> = {}) =>
  payment({
    kind: 'pack',
    planName: 'Пакет из 100 кредитов',
    period: null,
    amount: '1990.00',
    paidAt: new Date('2026-09-29T10:00:00Z'),
    createdAt: new Date('2026-09-29T09:59:00Z'),
    ...patch,
  })
const page = (items: PaymentEntry[], nextCursor: string | null = null): PaymentsPage => ({
  items,
  nextCursor,
})

function showBilling(
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  render(
    <QueryClientProvider client={queryClient}>
      <BillingView />
    </QueryClientProvider>,
  )
  return queryClient
}

const section = async (title: string) => {
  const found = (await screen.findByRole('heading', { level: 2, name: title })).closest('section')
  if (!found) throw new Error(`no section «${title}»`)
  return found
}
const method = () => section('Способ оплаты')
const text = (element: Element | null) => plain(element?.textContent)
const pageText = () => plain(document.body.textContent)
const button = (name: string) => screen.getByRole('button', { name })
const noButton = (name: string) =>
  expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()

/** A request that stays unanswered until the test answers it. */
function unanswered<T>(mock: { mockImplementationOnce: (fn: () => Promise<T>) => unknown }) {
  let answer!: (result: T) => void
  let refuse!: (error: Error) => void
  mock.mockImplementationOnce(
    () =>
      new Promise<T>((resolve, reject) => {
        answer = resolve
        refuse = reject
      }),
  )
  return { answer: (result: T) => answer(result), refuse: (error: Error) => refuse(error) }
}

const subscribed = (
  patch: Parameters<typeof subscriptionTo>[0] = {},
  waits: Partial<Pick<BillingOverview, 'bindingPending' | 'renewalCharge'>> = {},
) => getOverview.mockResolvedValue(overviewOf({ subscription: subscriptionTo(patch), ...waits }))
const withoutMethod = { autoRenewal: false, paymentMethod: null }
const VISA = { label: `Карта Visa ••${String.fromCharCode(0xa0)}1234` }

beforeEach(() => {
  vi.clearAllMocks()
  entries = 0
  getOverview.mockResolvedValue(overviewOf())
  getPayments.mockResolvedValue(page([]))
  startChange.mockResolvedValue({ confirmationUrl: bindingPage })
  unlinkMethod.mockResolvedValue({ unlinked: true, renewalCharge: 'none' })
  syncMethod.mockResolvedValue({ state: 'none', renewalCharge: 'none', subscription: null })
})

describe('the «Оплата» page while its data is on the way', () => {
  it('shows a placeholder until both answers arrive', async () => {
    const history = unanswered(getPayments)
    showBilling()

    expect(screen.getByRole('heading', { level: 1, name: 'Оплата' })).toBeInTheDocument()
    expect(pageText()).toContain('Способ оплаты и история платежей.')
    expect(screen.getByRole('status', { name: 'Загрузка оплаты' })).toBeInTheDocument()
    // The method is not shown before the history: one page, one state.
    await waitFor(() => expect(getOverview).toHaveBeenCalled())
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()

    await act(async () => history.answer(page([])))

    expect(await screen.findByRole('heading', { level: 2, name: 'Способ оплаты' })).toBeVisible()
    expect(screen.queryByRole('status', { name: 'Загрузка оплаты' })).not.toBeInTheDocument()
  })

  it('asks for the first page of the history without a cursor', async () => {
    showBilling()

    await method()
    expect(getPayments).toHaveBeenCalledExactlyOnceWith({})
  })

  it('reads the history anew on opening, however fresh the cache holds it', async () => {
    // As the application sets it: an answer is fresh for half a minute.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    })
    queryClient.setQueryData(['billing', 'overview'], overviewOf())
    queryClient.setQueryData(['billing-payments'], {
      pages: [page([payment({ planName: 'Старт' })])],
      pageParams: [null],
    })
    // Since the page was last open the customer has bought a pack on another one.
    getPayments.mockResolvedValue(page([pack(), payment({ planName: 'Старт' })]))

    showBilling(queryClient)

    // What the cache holds is on the screen at once, and the new order joins it.
    expect(await screen.findAllByRole('row')).toHaveLength(2)
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3))
    expect(getPayments).toHaveBeenCalledExactlyOnceWith({})
    // The tariff is as fresh as «Тарифы» left it: only what changes behind this page is asked.
    expect(getOverview).not.toHaveBeenCalled()
  })

  it.each([
    ['the tariff', () => getOverview.mockRejectedValueOnce(new Error('Network unavailable'))],
    ['the history', () => getPayments.mockRejectedValueOnce(new Error('Network unavailable'))],
  ])('offers a retry when %s fails to load, and asks again only for that', async (_case, fail) => {
    fail()
    showBilling()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось загрузить данные об оплате. Попробуйте ещё раз.',
    )
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()

    fireEvent.click(button('Повторить'))

    expect(await screen.findByRole('heading', { level: 2, name: 'Способ оплаты' })).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(getOverview.mock.calls.length + getPayments.mock.calls.length).toBe(3)
  })
})

describe('the payment method of a customer without a tariff', () => {
  it('says that no method is saved and how one gets saved, and offers nothing to press', async () => {
    showBilling()

    const block = await method()
    expect(text(block)).toContain('Способ оплаты не сохранён.')
    expect(text(block)).toContain('Он сохраняется, когда вы оплачиваете тариф с автопродлением.')
    expect(text(block)).not.toContain('автопродление выключено')
    expect(within(block).queryByRole('button')).not.toBeInTheDocument()
    // Nothing of a card is kept for a customer who has none.
    expect(text(block)).not.toContain('Данные карты хранит ЮKassa')
  })
})

describe('the saved payment method', () => {
  it('names the card and the next charge, and offers to replace and to unlink it', async () => {
    subscribed()
    showBilling()

    const block = await method()
    expect(text(block)).toContain('Карта «Мир» •• 4444')
    expect(text(block)).toContain(
      '18 октября спишем этим способом 12 900 ₽ за тариф «Бизнес». Если его отвязать, автопродление отключится.',
    )
    expect(text(block)).toContain(
      'Данные карты хранит ЮKassa. У нас — только идентификатор сохранённого способа оплаты и последние четыре цифры карты.',
    )
    expect(
      within(block)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['Заменить', 'Отвязать'])
    expect(button('Заменить')).toHaveClass('MuiButton-outlined')
    expect(text(block)).not.toContain('не сохранён')
  })

  it('names the tariff and the price that are scheduled for the next period', async () => {
    subscribed({ nextPlan: agencyPlan })
    showBilling()

    expect(text(await method())).toContain(
      '18 октября спишем этим способом 39 900 ₽ за тариф «Агентство».',
    )
  })

  it('promises no charge while auto-renewal is off', async () => {
    subscribed({ autoRenewal: false })
    showBilling()

    const block = await method()
    expect(text(block)).toContain('Карта «Мир» •• 4444')
    expect(text(block)).toContain(
      'Автопродление выключено: списаний не будет. Тариф действует до 18 октября 2026.',
    )
    expect(text(block)).not.toContain('спишем')
    expect(button('Заменить')).toBeEnabled()
    expect(button('Отвязать')).toBeEnabled()
  })

  it('promises no charge for a tariff that is not paid', async () => {
    subscribed({ status: 'past_due' })
    showBilling()

    const block = await method()
    expect(text(block)).toContain(
      'Оплата тарифа не прошла. Автоматических списаний не будет, пока тариф не оплачен.',
    )
    expect(text(block)).not.toContain('спишем')
  })

  it.each([
    [
      'at_bank',
      'Списание за следующий период уже отправлено в банк. Если способ оплаты отвязать, автопродление отключится, но это списание не отменится.',
    ],
    [
      'unanswered',
      'Списание за следующий период уже отправлялось в банк, ответа пока нет. Если способ оплаты отвязать, автопродление отключится, но это списание не отменится.',
    ],
  ] as const)(
    'names no charge to come while the charge of the period is under way (%s)',
    async (renewalCharge, note) => {
      subscribed({}, { renewalCharge })
      showBilling()

      const block = await method()
      expect(text(block)).toContain('Карта «Мир» •• 4444')
      expect(text(block)).toContain(note)
      // The card on the page may have been saved after the charge left: no «этим способом».
      expect(text(block)).not.toContain('спишем')
      expect(button('Заменить')).toBeEnabled()
      expect(button('Отвязать')).toBeEnabled()
    },
  )

  it('does not say that nothing will be charged while a charge that was started is at the bank', async () => {
    subscribed({ autoRenewal: false }, { renewalCharge: 'at_bank' })
    showBilling()

    const block = await method()
    expect(text(block)).toContain(
      'Автопродление выключено. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц. Других списаний не будет.',
    )
    expect(text(block)).not.toContain('списаний не будет. Тариф действует')
  })

  it('offers only to unlink while payments are off: nothing can be bound without the shop', async () => {
    getOverview.mockResolvedValue(
      overviewOf({ paymentsEnabled: false, subscription: subscriptionTo() }),
    )
    showBilling()

    const block = await method()
    expect(
      within(block)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['Отвязать'])

    // Its confirmation says nothing of auto-renewal being unavailable: that is the sentence of
    // a shop that takes one-time payments only, and here there is no shop.
    fireEvent.click(button('Отвязать'))
    const dialog = await screen.findByRole('dialog', { name: 'Отвязать способ оплаты?' })
    expect(text(dialog)).toContain('Автопродление отключится. Тариф «Бизнес» будет работать до')
    expect(text(dialog)).not.toMatch(/Привязать карту снова|автопродление недоступно/)
  })
})

describe('a tariff without a saved payment method', () => {
  it('says that auto-renewal is off and offers to bind a card, which switches nothing on', async () => {
    subscribed(withoutMethod)
    showBilling()

    const block = await method()
    expect(text(block)).toContain('Способ оплаты не сохранён: автопродление выключено.')
    expect(text(block)).toContain(
      'Тариф действует до 18 октября 2026. Можно привязать карту: она сохранится для будущих списаний. Автопродление при этом не включится, и денег с карты мы не спишем.',
    )
    expect(
      within(block)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['Привязать карту'])
    expect(text(block)).toContain('Данные карты хранит ЮKassa.')
  })

  it('offers no card to bind while payments are off', async () => {
    getOverview.mockResolvedValue(
      overviewOf({ paymentsEnabled: false, subscription: subscriptionTo(withoutMethod) }),
    )
    showBilling()

    const block = await method()
    expect(text(block)).toContain('Способ оплаты не сохранён: автопродление выключено.')
    expect(text(block)).toContain('Тариф действует до 18 октября 2026.')
    expect(text(block)).not.toContain('Можно привязать карту')
    expect(within(block).queryByRole('button')).not.toBeInTheDocument()
  })

  it('starts the same binding as a replacement does', async () => {
    subscribed(withoutMethod)
    showBilling()
    await method()

    fireEvent.click(button('Привязать карту'))

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledExactlyOnceWith(bindingPage))
    expect(startChange.mock.calls.map(([input]) => input)).toEqual([{}])
  })
})

describe('replacing the payment method', () => {
  it('starts one binding, however fast the button is pressed twice, and leaves for its page', async () => {
    subscribed()
    const request = unanswered(startChange)
    showBilling()
    await method()

    fireEvent.click(button('Заменить'))
    fireEvent.click(button('Заменить'))

    // The page is not left half-way: nothing else can be pressed meanwhile.
    await waitFor(() => expect(button('Отвязать')).toBeDisabled())
    expect(startChange.mock.calls.map(([input]) => input)).toEqual([{}])
    expect(hardNavigate).not.toHaveBeenCalled()

    await act(async () => request.answer({ confirmationUrl: bindingPage }))

    expect(hardNavigate).toHaveBeenCalledExactlyOnceWith(bindingPage)
    // The saved card stays until the new one is confirmed.
    expect(text(await method())).toContain('Карта «Мир» •• 4444')
  })

  it('shows the words of the server for a refusal and reads the page anew', async () => {
    subscribed()
    startChange.mockRejectedValueOnce(
      serverRefusal(
        'У вас нет действующего тарифа. Обновите страницу, чтобы увидеть, что изменилось',
        'BILLING_NO_LIVE_SUBSCRIPTION',
      ),
    )
    showBilling()
    await method()
    // What the refusal is about: the tariff is gone.
    getOverview.mockResolvedValue(overviewOf())

    fireEvent.click(button('Заменить'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'У вас нет действующего тарифа. Обновите страницу, чтобы увидеть, что изменилось.',
    )
    expect(hardNavigate).not.toHaveBeenCalled()
    await waitFor(() => expect(text(document.body)).toContain('Способ оплаты не сохранён.'))
    noButton('Заменить')
  })

  it('never shows the browser`s own words for a request that did not get through', async () => {
    subscribed()
    startChange.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    showBilling()
    await method()

    fireEvent.click(button('Заменить'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось начать привязку карты. Проверьте соединение и попробуйте ещё раз.',
    )
    expect(pageText()).not.toContain('Failed to fetch')
    // Another try is one press away.
    fireEvent.click(button('Заменить'))
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledExactlyOnceWith(bindingPage))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

// YOOKASSA_AUTOPAYMENTS=off: payments are on, and the shop saves no payment method.
describe('«Оплата» of a shop that takes one-time payments only', () => {
  const unavailable = 'Автопродление пока недоступно, поэтому способ оплаты не сохраняется.'

  it('names no way to save a method to a customer without a tariff', async () => {
    getOverview.mockResolvedValue(overviewOf(ONE_TIME_ONLY))
    showBilling()

    const block = await method()
    expect(text(block)).toContain('Способ оплаты не сохранён.')
    expect(text(block)).toContain(unavailable)
    expect(text(block)).not.toContain('тариф с автопродлением')
    expect(within(block).queryByRole('button')).not.toBeInTheDocument()
  })

  it('offers no «Привязать карту» to a tariff without a saved method, and says why', async () => {
    getOverview.mockResolvedValue(
      overviewOf({ ...ONE_TIME_ONLY, subscription: subscriptionTo(withoutMethod) }),
    )
    showBilling()

    const block = await method()
    expect(text(block)).toContain('Способ оплаты не сохранён: автопродление выключено.')
    expect(text(block)).toContain(`Тариф действует до 18 октября 2026. ${unavailable}`)
    expect(text(block)).not.toContain('Можно привязать карту')
    expect(within(block).queryByRole('button')).not.toBeInTheDocument()
    expect(startChange).not.toHaveBeenCalled()
  })

  it('offers no «Заменить» for a method saved before, and keeps «Отвязать»', async () => {
    getOverview.mockResolvedValue(overviewOf({ ...ONE_TIME_ONLY, subscription: subscriptionTo() }))
    showBilling()

    const block = await method()
    // The card is still the one the tariff is renewed with: the charge is named as it is.
    expect(text(block)).toContain('Карта «Мир» •• 4444')
    expect(text(block)).toContain(
      '18 октября спишем этим способом 12 900 ₽ за тариф «Бизнес». Если его отвязать, автопродление отключится.',
    )
    expect(
      within(block)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['Отвязать'])

    fireEvent.click(button('Отвязать'))
    const dialog = await screen.findByRole('dialog', { name: 'Отвязать способ оплаты?' })
    // The step cannot be taken back here — no «Привязать карту» follows it —, and the
    // customer reads that before taking it, as a part of what the dialog confirms.
    const warning =
      'Автопродление отключится. Тариф «Бизнес» будет работать до 18 октября 2026; после этого новые задачи не принимаются, пока вы снова не оплатите тариф. Привязать карту снова пока будет нельзя: автопродление недоступно.'
    expect(text(dialog)).toContain(warning)
    expect(
      plain(document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent),
    ).toContain(warning)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отвязать' }))

    await waitFor(() => expect(unlinkMethod).toHaveBeenCalledExactlyOnceWith({}, expect.anything()))
    expect(startChange).not.toHaveBeenCalled()
  })

  it('says in its own words why a stale «Заменить» was refused', async () => {
    // The page still offers the button: the shop stopped saving methods after it was read.
    subscribed()
    startChange.mockRejectedValueOnce(
      serverRefusal(
        'Автопродление пока недоступно. Оформите тариф без него: он будет действовать месяц',
        'BILLING_AUTO_RENEWAL_UNAVAILABLE',
      ),
    )
    showBilling()
    await method()
    getOverview.mockResolvedValue(overviewOf({ ...ONE_TIME_ONLY, subscription: subscriptionTo() }))

    fireEvent.click(button('Заменить'))

    // Not the server's sentence, which is about buying a tariff.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Привязать или заменить карту пока нельзя: автопродление недоступно.',
    )
    expect(hardNavigate).not.toHaveBeenCalled()
    // The page is read anew and offers the replacement no more.
    await waitFor(() => noButton('Заменить'))
    expect(button('Отвязать')).toBeEnabled()
  })
})

describe('unlinking the payment method', () => {
  const dialog = () => screen.getByRole('dialog', { name: 'Отвязать способ оплаты?' })

  async function openDialog(queryClient?: QueryClient) {
    showBilling(queryClient)
    await method()
    // A click of the test does not move the focus the way a click of a customer does.
    button('Отвязать').focus()
    fireEvent.click(button('Отвязать'))
    return dialog()
  }

  it('asks first, and says what happens to auto-renewal and how long the tariff works', async () => {
    subscribed()

    const asked = await openDialog()

    expect(asked).toHaveAccessibleDescription(
      new RegExp(
        plain('Карта «Мир» •• 4444').replaceAll(' ', String.raw`\s`) +
          String.raw`\s?Автопродление\sотключится\.\sТариф\s«Бизнес»\sбудет\sработать\sдо\s18\sоктября\s2026;`,
      ),
    )
    expect(text(asked)).toContain(
      'Автопродление отключится. Тариф «Бизнес» будет работать до 18 октября 2026; после этого новые задачи не принимаются, пока вы снова не оплатите тариф.',
    )
    expect(text(asked)).toContain(
      'Данные карты хранит ЮKassa. Мы удалим у себя идентификатор сохранённого способа оплаты и больше не сможем списывать с него деньги.',
    )
    // The card can be bound again on this page: nothing says that it cannot.
    expect(text(asked)).not.toContain('Привязать карту снова')
    expect(
      within(asked)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['Не отвязывать', 'Отвязать'])
    // Nothing is unlinked by opening the dialog.
    expect(unlinkMethod).not.toHaveBeenCalled()
  })

  it('says that tasks are taken after the tariff while the gift credits of the customer can start one', async () => {
    getOverview.mockResolvedValue(
      overviewOf({ subscription: subscriptionTo(), credits: creditBalances(800, 0, 35) }),
    )

    expect(text(await openDialog())).toContain(
      'Автопродление отключится. Тариф «Бизнес» будет работать до 18 октября 2026; после этого новые задачи принимаются, только пока есть подарочные кредиты.',
    )
    expect(text(dialog())).not.toContain('не принимаются')
  })

  it('keeps the words of the dialog where the gift starts no task', async () => {
    getOverview.mockResolvedValue(
      overviewOf({ subscription: subscriptionTo(), credits: creditBalances(800, 0, 4) }),
    )

    expect(text(await openDialog())).toContain(
      'после этого новые задачи не принимаются, пока вы снова не оплатите тариф.',
    )
  })

  it.each([
    [
      'auto-renewal that is off already',
      { autoRenewal: false },
      'Автопродление уже выключено. Тариф «Бизнес» работает до 18 октября 2026, как и раньше.',
    ],
    [
      'a tariff that is not paid',
      { status: 'past_due' as const },
      'Автоматических списаний не будет. Тариф «Бизнес» по-прежнему ждёт оплаты.',
    ],
  ])('tells the truth about %s', async (_case, patch, warning) => {
    subscribed(patch)

    expect(text(await openDialog())).toContain(warning)
  })

  it('says before the click that a charge under way is not stopped by unlinking', async () => {
    subscribed({}, { renewalCharge: 'at_bank' })

    const asked = await openDialog()

    expect(text(asked)).toContain(
      'Автопродление отключится. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц. Отвязка это списание не отменит; других списаний не будет.',
    )
    // No last day is promised that the charge may move.
    expect(text(asked)).not.toContain('будет работать до')
  })

  it('unlinks nothing when the customer changes their mind, and gives the focus back', async () => {
    subscribed()
    const asked = await openDialog()

    fireEvent.click(within(asked).getByRole('button', { name: 'Не отвязывать' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(unlinkMethod).not.toHaveBeenCalled()
    expect(button('Отвязать')).toHaveFocus()
    expect(text(await method())).toContain('Карта «Мир» •• 4444')
  })

  it('closes on Escape while nothing is being sent', async () => {
    subscribed()
    const asked = await openDialog()

    fireEvent.keyDown(asked, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(unlinkMethod).not.toHaveBeenCalled()
  })

  it('unlinks once, shows the method gone and auto-renewal off, and says so', async () => {
    subscribed()
    const request = unanswered(unlinkMethod)
    const asked = await openDialog()
    const confirm = within(asked).getByRole('button', { name: 'Отвязать' })
    // What the server answers once the method is unlinked.
    getOverview.mockResolvedValue(overviewOf({ subscription: subscriptionTo(withoutMethod) }))

    fireEvent.click(confirm)
    fireEvent.click(confirm)

    // Nothing closes the dialog while the request is on its way.
    await waitFor(() =>
      expect(within(asked).getByRole('button', { name: 'Не отвязывать' })).toBeDisabled(),
    )
    expect(unlinkMethod.mock.calls.map(([input]) => input)).toEqual([{}])
    fireEvent.keyDown(asked, { key: 'Escape' })
    // Long enough for a dialog that was told to close to be gone.
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)))
    expect(dialog()).toBeVisible()

    await act(async () => request.answer({ unlinked: true, renewalCharge: 'none' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const block = await method()
    expect(text(block)).toContain('Способ оплаты не сохранён: автопродление выключено.')
    expect(text(block)).not.toContain('Карта «Мир»')
    const said = within(block).getByRole('status')
    expect(text(said)).toBe('Способ оплаты отвязан, автопродление выключено.')
    // The button that opened the dialog is gone: the focus is on what happened.
    await waitFor(() => expect(said).toHaveFocus())
    expect(
      within(block)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['Привязать карту'])
    // The page is read anew after the change.
    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2))
  })

  it.each([
    [
      'is at the bank',
      'at_bank',
      'Способ оплаты отвязан, автопродление выключено. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц. Больше списаний не будет.',
      'Тариф действует до 18 октября 2026. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц.',
    ],
    [
      'has no answer',
      'unanswered',
      'Способ оплаты отвязан, автопродление выключено. Списание за следующий период уже отправлялось в банк, ответа пока нет. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их. Больше списаний не будет.',
      'Тариф действует до 18 октября 2026. Списание за следующий период уже отправлялось в банк, ответа пока нет. Мы проверим его: если деньги списаны, тариф продлится ещё на месяц или мы вернём их.',
    ],
  ] as const)(
    'tells at once of a renewal charge that was started before and %s',
    async (_case, renewalCharge, notice, note) => {
      subscribed()
      unlinkMethod.mockResolvedValue({ unlinked: true, renewalCharge })
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
      const asked = await openDialog(queryClient)
      // The reading after the unlink fails: what the unlink itself answered is all there is.
      getOverview.mockRejectedValue(new Error('Network unavailable'))

      fireEvent.click(within(asked).getByRole('button', { name: 'Отвязать' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      const block = await method()
      const said = within(block).getByRole('status')
      expect(text(said)).toBe(notice)
      await waitFor(() => expect(said).toHaveFocus())
      // The section under it does not call the tariff over on its last day either.
      expect(text(block)).toContain('Способ оплаты не сохранён: автопродление выключено.')
      expect(text(block)).toContain(note)
      // «Тарифы» reads the same answer.
      expect(queryClient.getQueryData<BillingOverview>(['billing', 'overview'])).toMatchObject({
        bindingPending: false,
        renewalCharge,
        subscription: { autoRenewal: false, paymentMethod: null },
      })
    },
  )

  it('keeps telling of that charge after the page is read anew, while it is under way', async () => {
    subscribed()
    unlinkMethod.mockResolvedValue({ unlinked: true, renewalCharge: 'at_bank' })
    const asked = await openDialog()
    getOverview.mockResolvedValue(
      overviewOf({ subscription: subscriptionTo(withoutMethod), renewalCharge: 'at_bank' }),
    )

    fireEvent.click(within(asked).getByRole('button', { name: 'Отвязать' }))

    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2))
    const block = await method()
    expect(text(block)).toContain(
      'Тариф действует до 18 октября 2026. Списание за следующий период уже отправлено в банк: если оно пройдёт, тариф продлится ещё на месяц. Можно привязать карту',
    )
    expect(text(within(block).getByRole('status'))).toContain('Больше списаний не будет.')
  })

  it('shows the method gone even when the reading after it fails', async () => {
    subscribed()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const asked = await openDialog(queryClient)
    getOverview.mockRejectedValue(new Error('Network unavailable'))

    fireEvent.click(within(asked).getByRole('button', { name: 'Отвязать' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2))
    const block = await method()
    expect(text(block)).toContain('Способ оплаты не сохранён: автопродление выключено.')
    expect(text(block)).not.toContain('Карта «Мир»')
    noButton('Отвязать')
    // «Тарифы» reads the same answer: it must not go on promising a charge either.
    expect(queryClient.getQueryData<BillingOverview>(['billing', 'overview'])).toMatchObject({
      subscription: { status: 'active', autoRenewal: false, paymentMethod: null },
    })
  })

  it('takes the notice back when a method is there again', async () => {
    subscribed()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const asked = await openDialog(queryClient)
    getOverview.mockResolvedValue(overviewOf({ subscription: subscriptionTo(withoutMethod) }))
    fireEvent.click(within(asked).getByRole('button', { name: 'Отвязать' }))
    expect(await within(await method()).findByRole('status')).toBeInTheDocument()

    // A card is bound in another tab, and this page reads its data anew.
    getOverview.mockResolvedValue(overviewOf({ subscription: subscriptionTo() }))
    await act(() => queryClient.invalidateQueries({ queryKey: ['billing', 'overview'] }))

    const block = await method()
    await waitFor(() => expect(text(block)).toContain('Карта «Мир» •• 4444'))
    expect(within(block).queryByRole('status')).not.toBeInTheDocument()
  })

  it('keeps the dialog open on a refusal, with the words of the server, and reads the page anew', async () => {
    subscribed()
    unlinkMethod.mockRejectedValueOnce(
      serverRefusal(
        'Это уже сделано. Обновите страницу, чтобы увидеть изменения',
        'BILLING_NOTHING_TO_CHANGE',
      ),
    )
    const asked = await openDialog()

    fireEvent.click(within(asked).getByRole('button', { name: 'Отвязать' }))

    expect(await within(asked).findByRole('alert')).toHaveTextContent(
      'Это уже сделано. Обновите страницу, чтобы увидеть изменения.',
    )
    expect(dialog()).toBeInTheDocument()
    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2))
    // Nothing is claimed to be unlinked.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('lets the customer try again after a request that did not get through', async () => {
    subscribed()
    unlinkMethod.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const asked = await openDialog()
    const confirm = within(asked).getByRole('button', { name: 'Отвязать' })

    fireEvent.click(confirm)

    expect(await within(asked).findByRole('alert')).toHaveTextContent(
      'Не удалось отвязать способ оплаты. Проверьте соединение и попробуйте ещё раз.',
    )
    expect(text(asked)).not.toContain('Failed to fetch')

    getOverview.mockResolvedValue(overviewOf({ subscription: subscriptionTo(withoutMethod) }))
    fireEvent.click(confirm)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(unlinkMethod).toHaveBeenCalledTimes(2)
    expect(within(await method()).getByRole('status')).toBeInTheDocument()
  })

  it('opens without the error of the try before', async () => {
    subscribed()
    unlinkMethod.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const asked = await openDialog()
    fireEvent.click(within(asked).getByRole('button', { name: 'Отвязать' }))
    await within(asked).findByRole('alert')
    fireEvent.click(within(asked).getByRole('button', { name: 'Не отвязывать' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.click(button('Отвязать'))

    expect(within(dialog()).queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('a binding that still waits when the page is opened', () => {
  const waiting = () => subscribed({}, { bindingPending: true })
  const settledWith = (state: MethodBinding['state'], patch: Partial<MethodBinding> = {}) =>
    syncMethod.mockResolvedValue({
      state,
      renewalCharge: 'none',
      subscription: subscriptionTo(),
      ...patch,
    })

  it('is settled once, and the card it saved is on the page', async () => {
    // The customer confirmed the card and left before the return page had an answer.
    waiting()
    const look = unanswered(syncMethod)
    showBilling()
    expect(text(await method())).toContain('Карта «Мир» •• 4444')
    await waitFor(() => expect(syncMethod.mock.calls).toEqual([[{}]]))
    // What the server answers once the card is stored.
    getOverview.mockResolvedValue(
      overviewOf({ subscription: subscriptionTo({ paymentMethod: VISA }) }),
    )

    await act(async () =>
      look.answer({
        state: 'active',
        renewalCharge: 'none',
        subscription: subscriptionTo({ paymentMethod: VISA }),
      }),
    )

    await waitFor(async () => expect(text(await method())).toContain('Карта Visa •• 1234'))
    expect(text(await method())).not.toContain('Карта «Мир»')
    expect(getOverview).toHaveBeenCalledTimes(2)
    expect(syncMethod).toHaveBeenCalledTimes(1)
  })

  it('is asked about once, not again and again, while the customer has not confirmed', async () => {
    waiting()
    settledWith('pending')
    const queryClient = showBilling()
    await method()
    await waitFor(() => expect(syncMethod).toHaveBeenCalledTimes(1))

    // The page reads its data anew for other reasons, and the binding still waits.
    await act(() => queryClient.invalidateQueries({ queryKey: ['billing', 'overview'] }))
    await act(() => queryClient.invalidateQueries({ queryKey: ['billing', 'overview'] }))

    expect(getOverview).toHaveBeenCalledTimes(3)
    expect(syncMethod).toHaveBeenCalledTimes(1)
    // A look without an outcome asks for no reading of its own.
    expect(text(await method())).toContain('Карта «Мир» •• 4444')
  })

  it('reads the page anew when the binding turns out refused', async () => {
    waiting()
    settledWith('inactive')
    showBilling()
    await method()

    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2))
    expect(syncMethod).toHaveBeenCalledTimes(1)
    // The saved card stays, and nothing alarms the customer about a look they did not ask for.
    expect(text(await method())).toContain('Карта «Мир» •• 4444')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('asks nothing when no binding waits', async () => {
    subscribed()
    showBilling()
    await method()
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    expect(syncMethod).not.toHaveBeenCalled()
    expect(getOverview).toHaveBeenCalledTimes(1)
  })

  it('asks nothing while payments are off: there is no shop to ask', async () => {
    getOverview.mockResolvedValue(
      overviewOf({ paymentsEnabled: false, subscription: subscriptionTo(), bindingPending: true }),
    )
    showBilling()
    await method()
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    expect(syncMethod).not.toHaveBeenCalled()
  })

  it.each([
    ['did not get through', new TypeError('Failed to fetch')],
    ['was refused', serverRefusal('Оплата сейчас недоступна', 'BILLING_PAYMENTS_NOT_CONFIGURED')],
  ])('leaves the page as it was when the look %s', async (_case, failure) => {
    waiting()
    syncMethod.mockRejectedValue(failure)
    const queryClient = showBilling()
    const block = await method()
    await waitFor(() => expect(syncMethod).toHaveBeenCalledTimes(1))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    // Nothing is said of it, and everything on the page works.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(pageText()).not.toMatch(/Failed to fetch|недоступна/)
    expect(text(block)).toContain('Карта «Мир» •• 4444')
    expect(button('Заменить')).toBeEnabled()
    expect(button('Отвязать')).toBeEnabled()
    // And it is not tried again behind the customer's back.
    await act(() => queryClient.invalidateQueries({ queryKey: ['billing', 'overview'] }))
    expect(syncMethod).toHaveBeenCalledTimes(1)
  })
})

describe('the payment history', () => {
  const history = () => section('История платежей')
  const rows = async () =>
    within(await history())
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => plain(cell.textContent)),
      )

  it('lists the payments with what each paid for, the amount and how it ended', async () => {
    subscribed()
    getPayments.mockResolvedValue(
      page([
        pack(),
        payment(),
        payment({
          planName: 'Старт',
          amount: '4900.00',
          status: 'failed',
          period: null,
          paidAt: null,
          createdAt: new Date('2026-08-18T09:00:00Z'),
          failureReason: 'general_decline',
          failureText: 'Банк отклонил платёж. Выберите другой способ оплаты или обратитесь в банк.',
        }),
        pack({
          status: 'refunded',
          paidAt: new Date('2026-08-02T10:00:00Z'),
          refundedAmount: '1990.00',
          refundedAt: new Date('2026-08-05T10:00:00Z'),
        }),
        pack({ status: 'pending', paidAt: null, createdAt: new Date('2026-07-30T09:00:00Z') }),
        pack({ status: 'cancelled', paidAt: null, createdAt: new Date('2026-07-29T09:00:00Z') }),
      ]),
    )
    showBilling()

    const block = await history()
    expect(text(block)).toContain('Платежи за тариф и пакеты кредитов.')
    const table = within(block).getByRole('table', { name: 'История платежей' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Дата', 'За что', 'Сумма', 'Статус'])
    expect(await rows()).toEqual([
      ['29 сентября 2026', 'Пакет из 100 кредитов', '1 990 ₽', 'Оплачено'],
      ['18 сентября 2026', 'Тариф «Бизнес»18 сентября — 18 октября', '12 900 ₽', 'Оплачено'],
      [
        '18 августа 2026',
        'Тариф «Старт»',
        '4 900 ₽',
        'Не прошёлБанк отклонил платёж. Выберите другой способ оплаты или обратитесь в банк.',
      ],
      ['2 августа 2026', 'Пакет из 100 кредитов', '1 990 ₽', 'Возвращено5 августа'],
      ['30 июля 2026', 'Пакет из 100 кредитов', '1 990 ₽', 'Ожидает оплаты'],
      ['29 июля 2026', 'Пакет из 100 кредитов', '1 990 ₽', 'Отменён'],
    ])
    // A status is words and a sign, never a colour alone.
    for (const label of ['Оплачено', 'Не прошёл', 'Возвращено', 'Ожидает оплаты', 'Отменён']) {
      const chip = within(table).getAllByText(label)[0]?.closest('.MuiChip-root')
      expect(chip?.querySelector('svg'), label).not.toBeNull()
    }
    // No receipts and no documents: the seller issues neither.
    expect(text(block)).not.toMatch(/чек|документ|НДС/i)
    noButton('Показать ещё')
  })

  it('scrolls a wide table inside a frame of its own, which the keyboard reaches', async () => {
    getPayments.mockResolvedValue(page([payment()]))
    showBilling()

    const frame = within(await history()).getByRole('group', { name: 'История платежей' })
    expect(frame).toHaveAttribute('tabindex', '0')
    expect(within(frame).getByRole('table')).toBeInTheDocument()
  })

  it('brings the next page on «Показать ещё» and takes the button away at the last one', async () => {
    const first = [pack(), payment()]
    const second = [payment({ planName: 'Старт', amount: '4900.00' })]
    getPayments.mockResolvedValueOnce(page(first, first[1]!.id))
    const next = unanswered(getPayments)
    showBilling()
    expect(await rows()).toHaveLength(2)

    fireEvent.click(button('Показать ещё'))

    // The page after the last order that is shown.
    await waitFor(() => expect(getPayments).toHaveBeenLastCalledWith({ cursor: first[1]!.id }))
    await waitFor(() => expect(button('Показать ещё')).toBeDisabled())
    expect(await rows()).toHaveLength(2)

    await act(async () => next.answer(page(second)))

    expect((await rows()).map(([, what]) => what)).toEqual([
      'Пакет из 100 кредитов',
      'Тариф «Бизнес»18 сентября — 18 октября',
      'Тариф «Старт»18 сентября — 18 октября',
    ])
    noButton('Показать ещё')
    expect(getPayments).toHaveBeenCalledTimes(2)
  })

  it('keeps what is shown when the next page fails, and lets the customer ask again', async () => {
    const first = [pack(), payment()]
    getPayments
      .mockResolvedValueOnce(page(first, first[1]!.id))
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce(page([payment({ planName: 'Старт' })]))
    showBilling()
    await rows()

    fireEvent.click(button('Показать ещё'))

    expect(await within(await history()).findByRole('alert')).toHaveTextContent(
      'Не удалось загрузить продолжение истории. Попробуйте ещё раз.',
    )
    expect(await rows()).toHaveLength(2)
    // The page itself did not fail.
    expect(pageText()).not.toContain('Не удалось загрузить данные об оплате')

    fireEvent.click(button('Показать ещё'))

    await waitFor(async () => expect(await rows()).toHaveLength(3))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(getPayments.mock.calls.map(([query]) => query)).toEqual([
      {},
      { cursor: first[1]!.id },
      { cursor: first[1]!.id },
    ])
  })
})

describe('a customer who has paid for nothing yet', () => {
  it('sees where the payments will be and the way to choose a tariff', async () => {
    showBilling()

    const empty = await section('Платежей пока нет')
    expect(text(empty)).toContain('Здесь появятся платежи за тариф и пакеты кредитов.')
    expect(within(empty).getByRole('link', { name: 'Выбрать тариф' })).toHaveAttribute(
      'href',
      '/settings/plans',
    )
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    noButton('Показать ещё')
    expect(screen.queryByRole('heading', { name: 'История платежей' })).not.toBeInTheDocument()
    // Nothing is promised that is not sold: no top-ups of a balance.
    expect(pageText()).not.toMatch(/пополнени|баланс/i)
  })

  it('is not sent to choose a tariff they already have', async () => {
    subscribed()
    showBilling()

    const empty = await section('Платежей пока нет')
    expect(within(empty).queryByRole('link')).not.toBeInTheDocument()
  })
})
