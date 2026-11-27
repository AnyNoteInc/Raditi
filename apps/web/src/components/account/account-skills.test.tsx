// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AccountSkill } from './account-skill-dialogs'
import { skillMdBody } from './account-skill-dialogs'
import { uploadSkillArchive } from './account-skill-install'
import { nbsp } from '@/lib/nbsp'

import { AccountSkills, marketplaceSkills, type Marketplace } from './account-skills'
import { accountSkillsText as text } from './account-skills-text'

// «Настройки → Навыки» (docs/plan/97-skills.md, Нв21): the page over a router of the test.

type Fn = (input: Record<string, unknown>) => Promise<unknown>
const calls = vi.hoisted(() => ({
  list: vi.fn<Fn>(),
  marketplaces: vi.fn<Fn>(),
  view: vi.fn<Fn>(),
  switch: vi.fn<Fn>(),
  remove: vi.fn<Fn>(),
  restore: vi.fn<Fn>(),
  installFromAddress: vi.fn<Fn>(),
  installFromMarketplace: vi.fn<Fn>(),
  checkUpdates: vi.fn<Fn>(),
  updatePreview: vi.fn<Fn>(),
  update: vi.fn<Fn>(),
  addMarketplace: vi.fn<Fn>(),
  removeMarketplace: vi.fn<Fn>(),
}))

vi.mock('@/trpc/client', () => {
  const mutation = (fn: Fn) => ({
    mutationOptions: (options?: UseMutationOptions<unknown, Error, Record<string, unknown>>) => ({
      ...options,
      mutationFn: (input: Record<string, unknown>) => fn(input),
    }),
  })
  const query = (path: string, fn: Fn) => ({
    queryKey: () => ['accountSkills', path],
    queryOptions: (input: Record<string, unknown> = {}) => ({
      queryKey: ['accountSkills', path, input],
      queryFn: () => fn(input),
    }),
  })
  return {
    useTRPC: () => ({
      accountSkills: {
        pathKey: () => ['accountSkills'],
        list: query('list', calls.list),
        marketplaces: query('marketplaces', calls.marketplaces),
        view: query('view', calls.view),
        switch: mutation(calls.switch),
        remove: mutation(calls.remove),
        restore: mutation(calls.restore),
        installFromAddress: mutation(calls.installFromAddress),
        installFromMarketplace: mutation(calls.installFromMarketplace),
        checkUpdates: mutation(calls.checkUpdates),
        updatePreview: mutation(calls.updatePreview),
        update: mutation(calls.update),
        addMarketplace: mutation(calls.addMarketplace),
        removeMarketplace: mutation(calls.removeMarketplace),
      },
    }),
  }
})

const OWN_ID = '0199a000-0000-7000-8000-0000000000a1'
const VERSION_ID = '0199a000-0000-7000-8000-0000000000b1'
const MARKET_ID = '0199a000-0000-7000-8000-0000000000d1'
const COMMIT = 'a'.repeat(40)
const NEXT = 'b'.repeat(40)

const skill = (patch: Partial<AccountSkill>): AccountSkill => ({
  id: null,
  name: 'x',
  title: 'x',
  description: 'x',
  summary: null,
  source: 'builtin',
  catalog: false,
  enabled: true,
  userOnly: false,
  license: null,
  sourceUrl: null,
  sourceLabel: 'Радити',
  commit: null,
  updateAvailable: false,
  files: 0,
  sizeBytes: 0,
  installedAt: null,
  updatedAt: null,
  history: [],
  ...patch,
})

const creator = skill({
  name: 'skill-creator',
  title: 'Создание навыков',
  description: 'Creates skills',
  summary: 'Помогает создать свой навык',
})
const pdf = skill({
  name: 'pdf',
  title: 'PDF',
  description: 'Работа с PDF',
  catalog: true,
  enabled: false,
})
const own = skill({
  id: OWN_ID,
  name: 'brand-voice',
  title: 'Голос бренда',
  description: 'Пишет в тоне компании',
  source: 'git',
  sourceUrl: `https://github.com/acme/skills/tree/${COMMIT}/brand-voice`,
  sourceLabel: 'github.com/acme/skills',
  commit: COMMIT,
  updateAvailable: true,
  files: 2,
  sizeBytes: 2048,
  installedAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-20T10:00:00.000Z',
  history: [{ id: VERSION_ID, commit: 'c'.repeat(40), createdAt: '2026-11-10T10:00:00.000Z' }],
})

const listOf = (
  skills: AccountSkill[],
  enabled = skills.filter((each) => each.enabled).length,
) => ({
  skills,
  limits: { installed: 50, enabled: 20 },
  counts: { installed: skills.filter((each) => each.id !== null).length, enabled },
})

const market: Marketplace = {
  id: MARKET_ID,
  name: 'anthropic-agent-skills',
  repo: 'anthropics/skills',
  host: 'github',
  url: 'https://github.com/anthropics/skills',
  platform: true,
  plugins: [
    {
      name: 'document-skills',
      description: 'Документы',
      repo: { host: 'github', repo: 'anthropics/skills', path: '' },
      skills: [
        { path: 'skills/xlsx', name: 'xlsx', description: 'Таблицы Excel' },
        { path: 'skills/docx', name: 'docx', description: 'Документы Word' },
        { path: 'skills/skill-creator', name: 'skill-creator', description: 'Чужой' },
      ],
    },
  ],
  fetchedAt: '2026-11-27T10:00:00.000Z',
  stale: false,
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <AccountSkills />
    </QueryClientProvider>,
  )
}

const menuOf = (title: string) =>
  fireEvent.click(screen.getByRole('button', { name: text.actions(title) }))

beforeEach(() => {
  Object.values(calls).forEach((call) => call.mockReset())
  calls.list.mockResolvedValue(listOf([creator, pdf, own]))
  calls.marketplaces.mockResolvedValue([market])
  calls.checkUpdates.mockResolvedValue({ found: 0 })
})

describe('«Навыки»', () => {
  it('lists the installed skills, the catalog of Радити and the marketplaces', async () => {
    show()
    const installed = await screen.findByRole('region', { name: text.installed })
    expect(within(installed).getByText('Создание навыков')).toBeTruthy()
    expect(within(installed).getByText('/skill-creator')).toBeTruthy()
    expect(within(installed).getByText('Помогает создать свой навык')).toBeTruthy()
    expect(within(installed).getByText('Голос бренда')).toBeTruthy()
    expect(within(installed).getByText(text.updateAvailable)).toBeTruthy()
    const source = within(installed).getByRole('link', { name: 'github.com/acme/skills' })
    expect(source.getAttribute('href')).toBe(own.sourceUrl)
    expect(within(installed).queryByText('PDF')).toBeNull()
    expect(screen.getByText(text.counter(2, 20))).toBeTruthy()

    const catalog = screen.getByRole('region', { name: text.catalog })
    expect(within(catalog).getByText('PDF')).toBeTruthy()

    const markets = screen.getByRole('region', { name: text.marketplaces })
    expect(await within(markets).findByText('xlsx')).toBeTruthy()
    expect(within(markets).getByText('docx')).toBeTruthy()
    expect(calls.checkUpdates).toHaveBeenCalledTimes(1)
  })

  it('finds the skills of a marketplace by their names and descriptions', async () => {
    show()
    const markets = await screen.findByRole('region', { name: text.marketplaces })
    await within(markets).findByText('xlsx')
    fireEvent.change(within(markets).getByLabelText(text.search), { target: { value: 'word' } })
    await waitFor(() => expect(within(markets).queryByText('xlsx')).toBeNull())
    expect(within(markets).getByText('docx')).toBeTruthy()
    fireEvent.change(within(markets).getByLabelText(text.search), {
      target: { value: 'нет такого' },
    })
    expect(await within(markets).findByText(text.nothingFound)).toBeTruthy()
  })

  it('switches a built-in skill by its name and an own one by its id', async () => {
    calls.switch.mockResolvedValue({ ok: true })
    show()
    await screen.findByText('Голос бренда')
    fireEvent.click(screen.getByRole('switch', { name: text.switchLabel('Создание навыков') }))
    await waitFor(() =>
      expect(calls.switch).toHaveBeenCalledWith({ builtin: 'skill-creator', enabled: false }),
    )
    fireEvent.click(screen.getByRole('switch', { name: text.switchLabel('Голос бренда') }))
    await waitFor(() =>
      expect(calls.switch).toHaveBeenLastCalledWith({ skillId: OWN_ID, enabled: false }),
    )
  })

  it('shows the words of the server when it refuses', async () => {
    calls.switch.mockRejectedValue({
      message: 'Включить можно до 20 навыков — выключите ненужные',
      data: { code: 'CONFLICT' },
    })
    show()
    const catalog = await screen.findByRole('region', { name: text.catalog })
    fireEvent.click(within(catalog).getByRole('button', { name: `${text.enable} «PDF»` }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Включить можно до 20 навыков — выключите ненужные.',
    )
    expect(calls.switch).toHaveBeenCalledWith({ builtin: 'pdf', enabled: true })
  })

  it('lets no skill on past the limit, and says why', async () => {
    calls.list.mockResolvedValue(listOf([creator, pdf, { ...own, enabled: false }], 20))
    show()
    await screen.findByText(text.counter(20, 20))
    expect(screen.getByText(text.enabledFull(20))).toBeTruthy()
    expect(
      (screen.getByRole('switch', { name: text.switchLabel('Голос бренда') }) as HTMLInputElement)
        .disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: `${text.enable} «PDF»` }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('shows an error when the list cannot be read', async () => {
    calls.list.mockRejectedValue(new Error('down'))
    show()
    expect((await screen.findByRole('alert')).textContent).toBe(text.loadFailed)
  })
})

describe('a skill of a marketplace with a taken name', () => {
  it('offers no install for a name of a skill of Радити', async () => {
    show()
    await screen.findByText('Чужой')
    expect(screen.queryByRole('button', { name: `${text.install} skill-creator` })).toBeNull()
    expect(screen.getAllByText(text.nameTaken).length).toBe(1)
  })
})

describe('installing', () => {
  it('by a link warns first, asks which of several, then whether to replace', async () => {
    calls.installFromAddress
      .mockResolvedValueOnce({
        status: 'choose',
        commit: COMMIT,
        skills: [
          { path: 'skills/a', name: 'alpha', description: 'Первый' },
          { path: 'skills/b', name: 'beta' },
        ],
      })
      .mockResolvedValueOnce({ status: 'exists', name: 'beta' })
      .mockResolvedValueOnce({ status: 'installed', skillId: OWN_ID, name: 'beta', enabled: true })
    show()
    await screen.findByText('Голос бренда')
    fireEvent.click(screen.getByRole('button', { name: text.addByLink }))
    const dialog = screen.getByRole('dialog', { name: text.linkTitle })
    expect(within(dialog).getByRole('note').textContent).toBe(nbsp(text.warning))
    fireEvent.change(within(dialog).getByLabelText(text.linkAddress), {
      target: { value: 'https://github.com/acme/skills' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: text.install }))

    const choose = await screen.findByRole('dialog', { name: text.chooseTitle })
    fireEvent.click(within(choose).getByRole('button', { name: `${text.install} beta` }))
    const exists = await screen.findByRole('dialog', { name: text.existsTitle })
    fireEvent.click(within(exists).getByRole('button', { name: text.replace }))

    expect(await screen.findByText(text.installedNotice('beta'))).toBeTruthy()
    expect(calls.installFromAddress.mock.calls.map(([input]) => input)).toEqual([
      { address: 'https://github.com/acme/skills' },
      { address: 'https://github.com/acme/skills', path: 'skills/b' },
      { address: 'https://github.com/acme/skills', path: 'skills/b', replace: true },
    ])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('from a marketplace names the plugin and the folder of the skill', async () => {
    calls.installFromMarketplace.mockResolvedValue({
      status: 'installed',
      skillId: OWN_ID,
      name: 'xlsx',
      enabled: false,
    })
    show()
    const markets = await screen.findByRole('region', { name: text.marketplaces })
    await within(markets).findByText('xlsx')
    fireEvent.click(within(markets).getByRole('button', { name: `${text.install} xlsx` }))
    const dialog = screen.getByRole('dialog', { name: text.installTitle('xlsx') })
    expect(within(dialog).getByRole('note')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: text.install }))
    expect(await screen.findByText(text.installedOff('xlsx'))).toBeTruthy()
    expect(calls.installFromMarketplace).toHaveBeenCalledWith({
      marketplaceId: MARKET_ID,
      plugin: 'document-skills',
      path: 'skills/xlsx',
    })
  })

  it('marks a skill of a marketplace the account has', async () => {
    calls.list.mockResolvedValue(listOf([creator, { ...own, name: 'docx' }]))
    show()
    const markets = await screen.findByRole('region', { name: text.marketplaces })
    await within(markets).findByText('xlsx')
    expect(within(markets).queryByRole('button', { name: `${text.install} docx` })).toBeNull()
    expect(within(markets).getByText(text.installedMark)).toBeTruthy()
  })

  it('posts an archive to the upload route and reads its answer', async () => {
    const answer = { status: 'installed', skillId: OWN_ID, name: 'brand-voice', enabled: true }
    const fetchFn = vi.fn(async () => Response.json(answer))
    const file = new File([new Uint8Array([80, 75, 3, 4])], 'brand voice.skill')
    await expect(uploadSkillArchive(file, true, fetchFn)).resolves.toEqual(answer)
    expect(fetchFn).toHaveBeenCalledWith('/api/skills/upload?name=brand+voice.skill&replace=1', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    })

    const refused = vi.fn(async () =>
      Response.json(
        { message: 'Навык не подходит: архив повреждён или это не zip' },
        { status: 400 },
      ),
    )
    await expect(uploadSkillArchive(file, false, refused)).rejects.toThrow(
      'Навык не подходит: архив повреждён или это не zip',
    )
    const big = { name: 'big.zip', size: 11 * 1024 * 1024 } as File
    await expect(uploadSkillArchive(big, false, fetchFn)).rejects.toThrow(text.fileTooLarge)
  })
})

describe('a row of «Установленные»', () => {
  it('opens the SKILL.md as Markdown with the files', async () => {
    calls.view.mockResolvedValue({
      skillMd:
        '---\nname: brand-voice\ndescription: x\n---\n# Как писать\n\nКоротко и **по делу**.',
      files: [
        { path: 'SKILL.md', sizeBytes: 1024, executable: false },
        { path: 'scripts/check.py', sizeBytes: 512, executable: true },
      ],
    })
    show()
    await screen.findByText('Голос бренда')
    menuOf('Голос бренда')
    fireEvent.click(screen.getByRole('menuitem', { name: text.open }))
    const dialog = screen.getByRole('dialog', { name: text.viewTitle('Голос бренда') })
    expect(await within(dialog).findByText('Как писать')).toBeTruthy()
    expect(within(dialog).getByText('по делу').tagName).toBe('STRONG')
    expect(within(dialog).queryByText(/name: brand-voice/)).toBeNull()
    expect(within(dialog).getByText(/scripts\/check\.py/).textContent).toContain(text.executable)
    expect(calls.view).toHaveBeenCalledWith({ skillId: OWN_ID })
  })

  it('updates to the commit the client saw in the preview', async () => {
    calls.updatePreview.mockResolvedValue({
      commit: NEXT,
      skillMd: '# Новое',
      added: ['scripts/new.py'],
      changed: ['SKILL.md'],
      removed: [],
    })
    calls.update.mockResolvedValue({ ok: true })
    show()
    await screen.findByText('Голос бренда')
    menuOf('Голос бренда')
    fireEvent.click(screen.getByRole('menuitem', { name: text.update }))
    const dialog = screen.getByRole('dialog', { name: text.updateTitle('Голос бренда') })
    expect(await within(dialog).findByText('scripts/new.py')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: text.update }))
    expect(await screen.findByText(text.updated('Голос бренда'))).toBeTruthy()
    expect(calls.update).toHaveBeenCalledWith({ skillId: OWN_ID, commit: NEXT })
  })

  it('brings a past version back', async () => {
    calls.restore.mockResolvedValue({ ok: true })
    show()
    await screen.findByText('Голос бренда')
    menuOf('Голос бренда')
    fireEvent.click(screen.getByRole('menuitem', { name: text.restore }))
    const dialog = screen.getByRole('dialog', { name: text.historyTitle('Голос бренда') })
    fireEvent.click(within(dialog).getByRole('button', { name: text.restoreVersion }))
    expect(await screen.findByText(text.restored('Голос бренда'))).toBeTruthy()
    expect(calls.restore).toHaveBeenCalledWith({ skillId: OWN_ID, versionId: VERSION_ID })
  })

  it('removes an own skill after the confirmation; a built-in one has no «Удалить»', async () => {
    calls.remove.mockResolvedValue({ ok: true })
    show()
    await screen.findByText('Голос бренда')
    menuOf('Создание навыков')
    expect(screen.queryByRole('menuitem', { name: text.remove })).toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    menuOf('Голос бренда')
    fireEvent.click(screen.getByRole('menuitem', { name: text.remove }))
    const dialog = screen.getByRole('dialog', { name: text.removeTitle('Голос бренда') })
    fireEvent.click(within(dialog).getByRole('button', { name: text.remove }))
    expect(await screen.findByText(text.removedNotice('Голос бренда'))).toBeTruthy()
    expect(calls.remove).toHaveBeenCalledWith({ skillId: OWN_ID })
  })
})

describe('helpers', () => {
  it('drops the frontmatter of a SKILL.md', () => {
    expect(skillMdBody('---\nname: a\ndescription: b\n---\n\n# A\n')).toBe('# A\n')
    expect(skillMdBody('# No frontmatter')).toBe('# No frontmatter')
  })

  it('lists a plugin without known skills as one item', () => {
    const plain = {
      ...market,
      plugins: [{ ...market.plugins[0]!, name: 'whole', skills: null }],
    }
    expect(marketplaceSkills(plain, '')).toEqual([
      { plugin: 'whole', path: undefined, name: 'whole', description: 'Документы' },
    ])
  })
})
