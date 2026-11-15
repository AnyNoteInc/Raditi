// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SITE_ID } from '@/components/chat/testing'

import { SiteAgentSkills, skillsText, type SkillsView } from './site-agent-skills'

type Answer = (input: Record<string, unknown>) => Promise<SkillsView>
const calls = vi.hoisted(() => ({
  switch: vi.fn<Answer>(),
  add: vi.fn<Answer>(),
  remove: vi.fn<Answer>(),
  key: vi.fn<Answer>(),
}))

const mutation = (fn: Answer) => ({
  mutationOptions: (options: UseMutationOptions<unknown, Error, Record<string, unknown>>) => ({
    ...options,
    mutationFn: fn,
  }),
})
const search = vi.hoisted(() => ({ value: '' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(search.value) }))
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    siteAgentSkills: {
      switch: mutation(calls.switch),
      add: mutation(calls.add),
      remove: mutation(calls.remove),
      key: mutation(calls.key),
    },
  }),
}))

const noAuth = { kind: 'none', headerName: null, state: 'ok', error: null } as const
const platform: SkillsView['skills'] = [
  {
    name: 'context7',
    title: 'Context7',
    description: 'Свежая документация библиотек и фреймворков, которыми сделан сайт.',
    builtin: true,
    url: null,
    enabled: true,
    auth: noAuth,
  },
  {
    name: 'playwright',
    title: 'Playwright',
    description: 'Браузер, в котором агент открывает страницы в интернете и ищет нужное.',
    builtin: true,
    url: null,
    enabled: true,
    auth: noAuth,
  },
]
const view = (patch: Partial<SkillsView> = {}): SkillsView => ({
  skills: platform,
  canManage: true,
  addable: 8,
  ...patch,
})

function show(initial: SkillsView) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <SiteAgentSkills siteId={SITE_ID} initial={initial} />
    </QueryClientProvider>,
  )
}

beforeEach(() => Object.values(calls).forEach((call) => call.mockReset()))

describe('«Навыки агента» of a site', () => {
  it('shows the platform skills on and switches one off', async () => {
    calls.switch.mockResolvedValue(
      view({ skills: [{ ...platform[0]!, enabled: false }, platform[1]!] }),
    )
    show(view())
    expect(screen.getByText(skillsText.title)).toBeTruthy()
    const context7 = screen.getByRole('switch', { name: skillsText.switchLabel('Context7') })
    expect((context7 as HTMLInputElement).checked).toBe(true)
    // A platform skill is switched, never removed.
    expect(screen.queryByRole('button', { name: skillsText.remove })).toBeNull()
    fireEvent.click(context7)
    await waitFor(() =>
      expect(
        (
          screen.getByRole('switch', {
            name: skillsText.switchLabel('Context7'),
          }) as HTMLInputElement
        ).checked,
      ).toBe(false),
    )
    expect(calls.switch).toHaveBeenCalledWith(
      { siteId: SITE_ID, name: 'context7', enabled: false },
      expect.anything(),
    )
  })

  it('adds a remote skill by its address and removes it again', async () => {
    const added = {
      name: 'docs',
      title: 'docs',
      description: null,
      builtin: false,
      url: 'https://docs.example.org/mcp',
      enabled: true,
      auth: noAuth,
    }
    calls.add.mockResolvedValue(view({ skills: [...platform, added], addable: 7 }))
    calls.remove.mockResolvedValue(view())
    show(view())
    fireEvent.change(screen.getByLabelText(skillsText.name), { target: { value: 'Docs' } })
    fireEvent.change(screen.getByLabelText(skillsText.url), {
      target: { value: 'https://docs.example.org/mcp' },
    })
    fireEvent.click(screen.getByRole('button', { name: skillsText.add }))
    await waitFor(() => expect(screen.getByText('https://docs.example.org/mcp')).toBeTruthy())
    expect(calls.add).toHaveBeenCalledWith(
      { siteId: SITE_ID, name: 'docs', url: 'https://docs.example.org/mcp' },
      expect.anything(),
    )
    const row = screen.getByText('https://docs.example.org/mcp').closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: skillsText.remove }))
    await waitFor(() => expect(screen.queryByText('https://docs.example.org/mcp')).toBeNull())
    expect(calls.remove).toHaveBeenCalledWith({ siteId: SITE_ID, name: 'docs' }, expect.anything())
  })

  it('says what is wrong with a name or an address before sending it', () => {
    show(view())
    fireEvent.change(screen.getByLabelText(skillsText.name), { target: { value: 'my_docs' } })
    fireEvent.change(screen.getByLabelText(skillsText.url), {
      target: { value: 'https://docs.example.org/mcp' },
    })
    fireEvent.click(screen.getByRole('button', { name: skillsText.add }))
    expect(screen.getByRole('alert').textContent).toBe(skillsText.nameInvalid)
    fireEvent.change(screen.getByLabelText(skillsText.name), { target: { value: 'docs' } })
    fireEvent.change(screen.getByLabelText(skillsText.url), {
      target: { value: 'https://docs.example.org/mcp?key=secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: skillsText.add }))
    expect(screen.getByRole('alert').textContent).toBe(skillsText.urlInvalid)
    expect(calls.add).not.toHaveBeenCalled()
  })

  it('shows a member the skills without a way to change them', () => {
    show(view({ canManage: false }))
    expect(screen.getByText(skillsText.readOnly)).toBeTruthy()
    for (const box of screen.getAllByRole('switch'))
      expect((box as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: skillsText.add })).toBeNull()
  })

  it('adds a server with a key in a header and never shows the key again', async () => {
    const added: SkillsView['skills'][number] = {
      name: 'menu',
      title: 'menu',
      description: null,
      builtin: false,
      url: 'https://mcp.krosha.example/v1/mcp',
      enabled: true,
      auth: { kind: 'header', headerName: 'X-Api-Key', state: 'ok', error: null },
    }
    calls.add.mockResolvedValue(view({ skills: [...platform, added], addable: 7 }))
    show(view())
    fireEvent.change(screen.getByLabelText(skillsText.name), { target: { value: 'menu' } })
    fireEvent.change(screen.getByLabelText(skillsText.url), {
      target: { value: 'https://mcp.krosha.example/v1/mcp' },
    })
    fireEvent.click(screen.getByLabelText(skillsText.authHeader))
    fireEvent.change(screen.getByLabelText(skillsText.headerName), {
      target: { value: 'X-Api-Key' },
    })
    const key = screen.getByLabelText(skillsText.headerValue) as HTMLInputElement
    expect(key.type).toBe('password')
    fireEvent.change(key, { target: { value: 'sk_live_0123456789' } })
    fireEvent.click(screen.getByRole('button', { name: skillsText.add }))
    await waitFor(() => expect(screen.getByText(skillsText.keyed('X-Api-Key'))).toBeTruthy())
    expect(calls.add).toHaveBeenCalledWith(
      {
        siteId: SITE_ID,
        name: 'menu',
        url: 'https://mcp.krosha.example/v1/mcp',
        header: { headerName: 'X-Api-Key', value: 'sk_live_0123456789' },
      },
      expect.anything(),
    )
    expect(document.body.textContent).not.toContain('sk_live_0123456789')
  })

  it('says a key was refused and replaces it', async () => {
    const refused: SkillsView['skills'][number] = {
      name: 'menu',
      title: 'menu',
      description: null,
      builtin: false,
      url: 'https://mcp.krosha.example/v1/mcp',
      enabled: true,
      auth: { kind: 'header', headerName: 'X-Api-Key', state: 'failed', error: 'unauthorized' },
    }
    calls.key.mockResolvedValue(
      view({
        skills: [...platform, { ...refused, auth: { ...refused.auth, state: 'ok', error: null } }],
      }),
    )
    show(view({ skills: [...platform, refused] }))
    expect(screen.getByText(skillsText.keyRefused)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: skillsText.replaceKey }))
    fireEvent.change(screen.getByLabelText(skillsText.headerValue), {
      target: { value: 'sk_live_new_01234' },
    })
    fireEvent.click(screen.getByRole('button', { name: skillsText.saveKey }))
    await waitFor(() => expect(screen.queryByText(skillsText.keyRefused)).toBeNull())
    expect(calls.key).toHaveBeenCalledWith(
      {
        siteId: SITE_ID,
        name: 'menu',
        header: { headerName: 'X-Api-Key', value: 'sk_live_new_01234' },
      },
      expect.anything(),
    )
  })

  it("starts a sign-in on the server's page and says how the return went", async () => {
    const assign = vi.fn()
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ authorizationUrl: 'https://auth.example.com/authorize?x=1' }),
          {
            status: 200,
          },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const location = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...location, assign },
    })
    try {
      show(view())
      fireEvent.change(screen.getByLabelText(skillsText.name), { target: { value: 'menu' } })
      fireEvent.change(screen.getByLabelText(skillsText.url), {
        target: { value: 'https://mcp.example.com/mcp' },
      })
      fireEvent.click(screen.getByLabelText(skillsText.authSignIn))
      expect(screen.getByText(skillsText.signInHelp)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: skillsText.signIn }))
      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith('https://auth.example.com/authorize?x=1'),
      )
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/mcp-oauth/start',
        expect.objectContaining({ method: 'POST' }),
      )
      expect(
        JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string),
      ).toEqual({
        siteId: SITE_ID,
        name: 'menu',
        url: 'https://mcp.example.com/mcp',
      })
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: location })
      vi.unstubAllGlobals()
    }
  })

  it('shows a server that needs a sign-in again with its button', () => {
    const signed: SkillsView['skills'][number] = {
      name: 'menu',
      title: 'menu',
      description: null,
      builtin: false,
      url: 'https://mcp.example.com/mcp',
      enabled: true,
      auth: { kind: 'oauth', headerName: null, state: 'needs_login', error: 'unauthorized' },
    }
    show(view({ skills: [...platform, signed] }))
    expect(screen.getByText(skillsText.needsLogin)).toBeTruthy()
    expect(screen.getByRole('button', { name: skillsText.signInAgain })).toBeTruthy()
  })

  it('says how the return from a sign-in went', () => {
    search.value = 'mcp=signed-in&skill=menu'
    try {
      show(view())
      expect(screen.getByRole('status').textContent).toBe(skillsText.outcome['signed-in']!('menu'))
    } finally {
      search.value = ''
    }
  })
})
