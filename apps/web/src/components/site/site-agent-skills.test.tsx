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
}))

const mutation = (fn: Answer) => ({
  mutationOptions: (options: UseMutationOptions<unknown, Error, Record<string, unknown>>) => ({
    ...options,
    mutationFn: fn,
  }),
})
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    siteAgentSkills: {
      switch: mutation(calls.switch),
      add: mutation(calls.add),
      remove: mutation(calls.remove),
    },
  }),
}))

const platform: SkillsView['skills'] = [
  {
    name: 'context7',
    title: 'Context7',
    description: 'Свежая документация библиотек и фреймворков, которыми сделан сайт.',
    builtin: true,
    url: null,
    enabled: true,
  },
  {
    name: 'playwright',
    title: 'Playwright',
    description: 'Браузер, в котором агент открывает страницы в интернете и ищет нужное.',
    builtin: true,
    url: null,
    enabled: true,
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
})
