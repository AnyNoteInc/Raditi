// @vitest-environment jsdom
import { signupGiftCredits } from '@repo/domain/billing/credit-numbers'
import { leadFieldErrors } from '@repo/domain/leads/lead-input'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SITE_PHONE } from '@/lib/contacts'

import { LandingLead } from './landing-lead'
import { HANGING, plain } from './testing'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LandingLead', () => {
  const site = () => screen.getByLabelText('Сайт компании')
  const contact = () => screen.getByLabelText('Телефон или Telegram')
  const fill = (phone = '+7 900 000-00-00') => {
    fireEvent.change(site(), { target: { value: 'kofeinya.ru' } })
    fireEvent.change(contact(), { target: { value: phone } })
    fireEvent.click(screen.getByRole('checkbox'))
  }
  const send = () => fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }))
  /** What the form posted, as the server reads it. */
  const posted = (fetchMock: ReturnType<typeof vi.fn>) => {
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/leads',
      expect.objectContaining({ method: 'POST' }),
    )
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    return JSON.parse(String(init.body)) as unknown
  }

  it('offers a signed-in visitor the free help and no second gift', () => {
    const { container } = render(<LandingLead isGuest={false} />)
    const text = plain(container.textContent)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      /^0 ₽ за помощь\s*с началом\.$/,
    )
    expect(text).not.toMatch(/подарок|кредитов/)
  })

  it('says that the help is free and the gift is 50 credits', () => {
    const { container } = render(<LandingLead isGuest />)
    const text = plain(container.textContent)
    expect(text).toContain('Помощь с первыми задачами — бесплатно')
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      /^50 кредитов в подарок\s*за заявку\.$/,
    )
    expect(signupGiftCredits).toBe(50)
  })

  it('asks for two things only: the site of the business and a phone or a Telegram name', () => {
    for (const isGuest of [true, false]) {
      const { container, unmount } = render(<LandingLead isGuest={isGuest} />)

      // The trap is hidden from the tree, so these are all the fields a visitor meets.
      expect(screen.getAllByRole('textbox')).toEqual([site(), contact()])
      expect(screen.getAllByRole('checkbox')).toHaveLength(1)
      for (const field of [site(), contact(), screen.getByRole('checkbox')]) {
        expect(field).toBeRequired()
      }
      expect(site()).toHaveAttribute('name', 'site')
      expect(contact()).toHaveAttribute('name', 'phone')
      // A nick is typed with letters: the keyboard of a phone number would not let it in.
      expect(contact()).toHaveAttribute('type', 'text')
      expect(contact()).not.toHaveAttribute('inputmode', 'tel')
      for (const gone of ['Имя', 'Электронная почта', 'Что хотите менять на сайте']) {
        expect(screen.queryByLabelText(gone)).not.toBeInTheDocument()
      }
      expect(container.querySelector('textarea, input[type="email"]')).toBeNull()
      // The words around the form count the fields as the form has them.
      const text = plain(container.textContent)
      expect(text).toContain('Оба поля обязательны')
      expect(text).toContain('Два поля, одна минута')
      expect(text).toContain('Оставьте сайт компании и телефон — расскажем')
      expect(text).not.toMatch(/подключ/i)
      unmount()
    }
  })

  it('keeps the trap for robots out of reach of people', () => {
    const { container } = render(<LandingLead isGuest />)
    const trap = container.querySelector<HTMLInputElement>('input[name="raditi_check"]')

    expect(trap?.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(trap).toHaveAttribute('tabindex', '-1')
    expect(trap).toHaveAttribute('autocomplete', 'off')
    expect(trap).not.toBeRequired()
  })

  it('offers to call instead, by the phone of the service', () => {
    for (const isGuest of [true, false]) {
      const { container, unmount } = render(<LandingLead isGuest={isGuest} />)

      const call = screen.getByRole('link', { name: SITE_PHONE.text })
      expect(call).toHaveAttribute('href', `tel:${SITE_PHONE.tel}`)
      expect(plain(call.parentElement?.textContent)).toBe(`Или позвоните: ${SITE_PHONE.text}`)
      // The form is still there to send: the phone is a second way, not the first.
      expect(container.querySelector('form')).not.toBeNull()
      unmount()
    }
  })

  it('leaves no short preposition or conjunction at the end of a line of its prose', () => {
    for (const isGuest of [true, false]) {
      const { container, unmount } = render(<LandingLead isGuest={isGuest} />)
      const prose = [...container.querySelectorAll('h2, h3, p, strong, span')]
        .filter((element) => element.closest('a, button, label') === null)
        .flatMap((element) => [...element.childNodes])
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')

      expect(prose.length).toBeGreaterThan(10)
      expect(prose.filter((text) => HANGING.test(text))).toEqual([])
      unmount()
    }
  })

  it('names every empty field and sends nothing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<LandingLead isGuest />)

    send()

    expect(await screen.findByText('Например, kofeinya.ru')).toBeInTheDocument()
    for (const words of [
      'Нужен номер телефона или ник в Telegram',
      'Без согласия мы не сможем ответить',
    ]) {
      expect(screen.getByText(words)).toBeInTheDocument()
    }
    // The words are those of the schema the server answers with; nothing else is marked.
    expect(Object.keys(leadFieldErrors)).toEqual(['site', 'phone', 'consent'])
    for (const field of [site(), contact(), screen.getByRole('checkbox')]) {
      expect(field).toHaveAttribute('aria-invalid', 'true')
      // The field is described by its own message.
      const message = document.getElementById(field.getAttribute('aria-describedby') ?? '')
      expect(message?.textContent).toBe(
        leadFieldErrors[field.getAttribute('name') as keyof typeof leadFieldErrors],
      )
    }
    // The first of them takes the focus.
    expect(site()).toHaveFocus()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says at once when a field is right again, after the first try', async () => {
    vi.stubGlobal('fetch', vi.fn())
    render(<LandingLead isGuest />)
    // Before the first try a field is not judged while it is typed.
    fireEvent.change(contact(), { target: { value: 'анна' } })
    expect(contact()).not.toHaveAttribute('aria-invalid')

    send()
    expect(await screen.findByText(leadFieldErrors.phone)).toBeInTheDocument()

    fireEvent.change(contact(), { target: { value: '8 900 000-00-00' } })
    expect(screen.queryByText(leadFieldErrors.phone)).not.toBeInTheDocument()
    expect(contact()).not.toHaveAttribute('aria-invalid')
    expect(contact()).not.toHaveAttribute('aria-describedby')
    // A bare word is not a Telegram name: nothing tells it from a typo.
    fireEvent.change(contact(), { target: { value: 'kofeinya' } })
    expect(screen.getByText(leadFieldErrors.phone)).toBeInTheDocument()
    expect(site()).toHaveAttribute('aria-invalid', 'true')
  })

  it('posts the two fields and says the lead is in, by no name', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    render(<LandingLead isGuest />)
    fill()

    send()

    // The form asks no name, so the card thanks by none.
    expect(await screen.findByRole('heading', { name: /^Заявка у\s+нас\.$/ })).toHaveFocus()
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent(/Свяжемся с вами и поможем начать\./)
    expect(status).toHaveTextContent(/50\sкредитов придут, как только вы зарегистрируетесь/)
    expect(status).not.toHaveTextContent(/спасибо|,\s+[А-ЯЁ][а-яё]+\./i)
    // Only what the form asks: the site, the contact, the consent and the empty trap.
    expect(posted(fetchMock)).toEqual({
      site: 'kofeinya.ru',
      phone: '+7 900 000-00-00',
      consent: true,
      check: '',
    })

    // Another lead starts from an empty form.
    fireEvent.click(screen.getByRole('button', { name: 'Отправить ещё одну' }))
    expect(site()).toHaveValue('')
    expect(contact()).toHaveValue('')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.queryByText(leadFieldErrors.site)).not.toBeInTheDocument()
  })

  it.each(['@kofeinya_bar', 't.me/kofeinya_bar', 'https://t.me/kofeinya_bar'])(
    'accepts the Telegram name %s in place of a phone',
    async (nick) => {
      const fetchMock = vi.fn(async () => Response.json({ ok: true }))
      vi.stubGlobal('fetch', fetchMock)
      render(<LandingLead isGuest={false} />)
      fill(nick)

      send()

      expect(await screen.findByRole('status')).toHaveTextContent(/поможем начать/)
      // A signed-in visitor has had the gift: the card promises none.
      expect(screen.getByRole('status')).not.toHaveTextContent(/кредит|подар|зарегистр/i)
      expect(screen.queryByText(leadFieldErrors.phone)).not.toBeInTheDocument()
      // As typed: the server writes it in its one form.
      expect(posted(fetchMock)).toEqual({
        site: 'kofeinya.ru',
        phone: nick,
        consent: true,
        check: '',
      })
    },
  )

  it('shows what the server refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            message: 'Заявок с этого адреса слишком много. Попробуйте через час.',
            fields: { phone: leadFieldErrors.phone },
          },
          { status: 429 },
        ),
      ),
    )
    render(<LandingLead isGuest={false} />)
    fill()

    send()

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Заявок с этого адреса слишком много.'),
    )
    // What was typed stays, and the field the server named is marked.
    expect(site()).toHaveValue('kofeinya.ru')
    expect(contact()).toHaveValue('+7 900 000-00-00')
    expect(contact()).toHaveAttribute('aria-invalid', 'true')
    expect(site()).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
