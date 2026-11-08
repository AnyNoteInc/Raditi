// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LandingLead } from './landing-lead'
import { LandingPlatforms, platforms } from './landing-platforms'
import { plain } from './testing'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LandingPlatforms', () => {
  it('names the five systems the owner listed, in his order', () => {
    render(<LandingPlatforms />)
    const list = screen.getByRole('list', { name: 'Поддерживаемые системы' })
    expect(
      within(list)
        .getAllByRole('button')
        .map((button) => plain(button.textContent)),
    ).toEqual(platforms.map((platform, index) => `0${index + 1}${platform.name}${platform.parts}`))
    expect(platforms.map((platform) => platform.name)).toEqual([
      'WordPress',
      'Joomla',
      'OpenCart',
      'MODX',
      '1С-Битрикс',
    ])
  })

  it('shows the example of the chosen system and says none is coming later', () => {
    const { container } = render(<LandingPlatforms />)
    const example = () => plain(container.querySelector('#platform-example')?.textContent)
    expect(screen.getByRole('button', { name: /WordPress/, pressed: true })).toBeInTheDocument()
    expect(example()).toContain('Добавь новость о летнем меню')

    fireEvent.click(screen.getByRole('button', { name: /OpenCart/ }))

    expect(screen.getByRole('button', { name: /OpenCart/, pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /WordPress/, pressed: false })).toBeInTheDocument()
    expect(example()).toContain('Подними цены на кофе на 10%')
    expect(example()).toContain('Новые цены в категории «Кофе»')
    expect(plain(container.textContent)).not.toMatch(/скоро|в планах|позже/i)
  })
})

describe('LandingLead', () => {
  const fill = () => {
    fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'Анна Петрова' } })
    fireEvent.change(screen.getByLabelText('Телефон'), { target: { value: '+7 900 000-00-00' } })
    fireEvent.change(screen.getByLabelText('Электронная почта'), {
      target: { value: 'anna@example.ru' },
    })
    fireEvent.change(screen.getByLabelText('Адрес сайта'), { target: { value: 'kofeinya.ru' } })
    fireEvent.change(screen.getByLabelText('Что хотите менять на сайте'), {
      target: { value: 'Цены в меню и новости' },
    })
    fireEvent.click(screen.getByRole('checkbox'))
  }

  it('offers a signed-in visitor the free connection and no second gift', () => {
    const { container } = render(<LandingLead isGuest={false} />)
    const text = plain(container.textContent)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      /^0 ₽ за подключение\s*и настройку\.$/,
    )
    expect(text).not.toMatch(/подарок|кредитов/)
  })

  it('says that connecting is free and the gift is 50 credits', () => {
    const { container } = render(<LandingLead isGuest />)
    const text = plain(container.textContent)
    expect(text).toContain('Подключение и настройка — бесплатно')
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      /^50 кредитов в подарок\s*за заявку\.$/,
    )
  })

  it('names every empty field and sends nothing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<LandingLead isGuest />)

    fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }))

    expect(await screen.findByText('Напишите, как к вам обращаться')).toBeInTheDocument()
    for (const words of [
      'Нужен номер из 10–15 цифр',
      'Проверьте адрес почты',
      'Например, kofeinya.ru',
      'Расскажите хотя бы в одном предложении',
      'Без согласия мы не сможем ответить',
    ]) {
      expect(screen.getByText(words)).toBeInTheDocument()
    }
    expect(screen.getByLabelText('Имя')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Имя')).toHaveFocus()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts the lead and thanks the visitor by name', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    render(<LandingLead isGuest />)
    fill()

    fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }))

    expect(await screen.findByRole('heading', { name: /^Заявка у\s+нас, Анна\.$/ })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(/подключим kofeinya\.ru/)
    expect(screen.getByRole('status')).toHaveTextContent(
      /50\sкредитов придут, как только вы зарегистрируетесь/,
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/leads',
      expect.objectContaining({ method: 'POST' }),
    )
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'Анна Петрова',
      phone: '+7 900 000-00-00',
      email: 'anna@example.ru',
      site: 'kofeinya.ru',
      about: 'Цены в меню и новости',
      consent: true,
      check: '',
    })
  })

  it('shows what the server refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { message: 'Заявок с этого адреса слишком много. Попробуйте через час.' },
          { status: 429 },
        ),
      ),
    )
    render(<LandingLead isGuest={false} />)
    fill()

    fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Заявок с этого адреса слишком много.'),
    )
    expect(screen.getByLabelText('Имя')).toHaveValue('Анна Петрова')
  })
})
