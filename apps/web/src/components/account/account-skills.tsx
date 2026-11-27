'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import Link from '@mui/material/Link'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import type { AppRouter } from '@repo/trpc'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { inferRouterOutputs } from '@trpc/server'
import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { ConfirmDialog } from '@/components/billing/confirm-dialog'
import { callErrorText } from '@/components/chat/call-error'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

import {
  HistorySkillDialog,
  UpdateSkillDialog,
  ViewSkillDialog,
  type AccountSkill,
} from './account-skill-dialogs'
import { InstallSkillDialog, type InstallAnswer, type InstallTarget } from './account-skill-install'
import { accountSkillsText as text } from './account-skills-text'

// «Настройки → Навыки» (docs/plan/97-skills.md, Нв21): the skills of the user's account — folders
// with SKILL.md every new chat of theirs gets while they are on. «Установленные» holds the
// built-in ones and the user's own, «Каталог Радити» the built-in skills of the catalog not yet
// on, «Каталоги навыков» the marketplaces with their skills. Nothing not of Радити is installed
// without the warning of Нв12. The server checks every change again (`accountSkills`).

export type Marketplace = inferRouterOutputs<AppRouter>['accountSkills']['marketplaces'][number]
type Installed = Extract<InstallAnswer, { status: 'installed' }>

/** How many skills of the marketplaces a search shows at most. */
export const MARKETPLACE_SHOWN = 50

/** A card of the page: its title, a note under it, what stands at its right and what it holds. */
function Section({
  title,
  note,
  aside,
  heading = 'h2',
  children,
}: {
  title: string
  note?: ReactNode
  aside?: ReactNode
  heading?: 'h1' | 'h2'
  children: ReactNode
}) {
  return (
    <Box
      component="section"
      aria-label={title}
      sx={{ border: 1, borderColor: 'divider', borderRadius: '14px', minWidth: 0 }}
    >
      <Box
        sx={{
          px: { xs: 2, sm: 2.75 },
          py: 2,
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          gap: 1.5,
        }}
      >
        <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
          <Typography component={heading} sx={{ fontSize: 17, fontWeight: 600 }}>
            {title}
          </Typography>
          {note ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 720 }}>
              {note}
            </Typography>
          ) : null}
        </Box>
        {aside}
      </Box>
      {children}
    </Box>
  )
}

const rowSx = {
  px: { xs: 2, sm: 2.75 },
  py: 1.75,
  display: 'flex',
  alignItems: 'flex-start',
  gap: { xs: 1, sm: 2 },
  borderBottom: 1,
  borderColor: 'divider',
  '&:last-of-type': { borderBottom: 0 },
} as const

/** The name of a skill as the chat calls it. */
function SlashChip({ name }: { name: string }) {
  return (
    <Chip
      size="small"
      label={`/${name}`}
      translate="no"
      sx={{ height: 22, fontSize: 12.5, maxWidth: '100%' }}
    />
  )
}

/** The words of a skill: its title, `/name`, what it does and where it came from. */
function SkillWords({ skill, children }: { skill: AccountSkill; children?: ReactNode }) {
  return (
    <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75 }}>
        <Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{skill.title}</Typography>
        <SlashChip name={skill.name} />
        {skill.updateAvailable ? (
          <Chip
            size="small"
            color="primary"
            variant="outlined"
            label={text.updateAvailable}
            sx={{ height: 22 }}
          />
        ) : null}
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
        {nbsp(skill.summary ?? skill.description)}
      </Typography>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mt: 0.25, overflowWrap: 'anywhere' }}
      >
        {skill.sourceUrl ? (
          <Link href={skill.sourceUrl} target="_blank" rel="noopener noreferrer" color="inherit">
            {skill.sourceLabel}
          </Link>
        ) : (
          skill.sourceLabel
        )}
        {skill.userOnly ? ` · ${text.userOnly(skill.name)}` : null}
      </Typography>
      {children}
    </Box>
  )
}

/** The menu of a row: «Открыть», «Обновить», «Вернуть прошлую версию», «Удалить». */
function RowMenu({
  skill,
  onOpen,
  onUpdate,
  onHistory,
  onRemove,
}: {
  skill: AccountSkill
  onOpen: () => void
  onUpdate: () => void
  onHistory: () => void
  onRemove: () => void
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const pick = (action: () => void) => () => {
    setAnchor(null)
    action()
  }
  return (
    <>
      <IconButton
        aria-label={text.actions(skill.title)}
        aria-haspopup="menu"
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{ flexShrink: 0, width: 44, height: 44 }}
      >
        <AppIcon name="more" size={18} />
      </IconButton>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        <MenuItem onClick={pick(onOpen)}>{text.open}</MenuItem>
        {skill.updateAvailable ? <MenuItem onClick={pick(onUpdate)}>{text.update}</MenuItem> : null}
        {skill.id !== null && skill.history.length > 0 ? (
          <MenuItem onClick={pick(onHistory)}>{text.restore}</MenuItem>
        ) : null}
        {skill.id !== null ? (
          <MenuItem onClick={pick(onRemove)} sx={{ color: 'error.main' }}>
            {text.remove}
          </MenuItem>
        ) : null}
      </Menu>
    </>
  )
}

/** The skills of the marketplaces, flat, filtered by the words searched for. */
export function marketplaceSkills(marketplace: Marketplace, query: string) {
  const words = query.trim().toLowerCase()
  const items = marketplace.plugins.flatMap((plugin) =>
    plugin.skills === null
      ? [
          {
            plugin: plugin.name,
            path: undefined,
            name: plugin.name,
            description: plugin.description,
          },
        ]
      : plugin.skills.map((skill) => ({
          plugin: plugin.name,
          path: skill.path as string | undefined,
          name: skill.name,
          description: skill.description ?? plugin.description,
        })),
  )
  if (words === '') return items
  return items.filter((item) =>
    [item.name, item.description ?? '', item.plugin].some((field) =>
      field.toLowerCase().includes(words),
    ),
  )
}

/** «Настройки → Навыки». */
export function AccountSkills() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const list = useQuery(trpc.accountSkills.list.queryOptions())
  const marketplaces = useQuery(trpc.accountSkills.marketplaces.queryOptions())
  const switchSkill = useMutation(trpc.accountSkills.switch.mutationOptions())
  const removeSkill = useMutation(trpc.accountSkills.remove.mutationOptions())
  const addMarketplace = useMutation(trpc.accountSkills.addMarketplace.mutationOptions())
  const removeMarketplace = useMutation(trpc.accountSkills.removeMarketplace.mutationOptions())
  const { mutateAsync: checkUpdates } = useMutation(
    trpc.accountSkills.checkUpdates.mutationOptions(),
  )

  const [installing, setInstalling] = useState<InstallTarget | null>(null)
  const [viewing, setViewing] = useState<AccountSkill | null>(null)
  const [updating, setUpdating] = useState<AccountSkill | null>(null)
  const [history, setHistory] = useState<AccountSkill | null>(null)
  const [removing, setRemoving] = useState<AccountSkill | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const query = useDeferredValue(search)
  const [marketplaceAddress, setMarketplaceAddress] = useState('')
  const [marketplaceProblem, setMarketplaceProblem] = useState<string | null>(null)

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.accountSkills.pathKey() })

  // Once on opening: the sources are asked for newer commits, and the list shows what they said.
  const checked = useRef(false)
  useEffect(() => {
    if (checked.current) return
    checked.current = true
    checkUpdates()
      .then(({ found }) => {
        if (found > 0)
          void queryClient.invalidateQueries({ queryKey: trpc.accountSkills.list.queryKey() })
      })
      .catch(() => {})
  }, [checkUpdates, queryClient, trpc])

  const said = (words: string) => {
    setProblem(null)
    setNotice(words)
    refresh()
  }
  const toggle = async (skill: AccountSkill, enabled: boolean) => {
    setProblem(null)
    setNotice(null)
    try {
      await switchSkill.mutateAsync(
        skill.id !== null ? { skillId: skill.id, enabled } : { builtin: skill.name, enabled },
      )
      refresh()
    } catch (failure) {
      setProblem(callErrorText(failure))
    }
  }
  const confirmRemove = async () => {
    if (removing?.id == null) return
    setRemoveError(null)
    try {
      await removeSkill.mutateAsync({ skillId: removing.id })
      const title = removing.title
      setRemoving(null)
      said(text.removedNotice(title))
    } catch (failure) {
      setRemoveError(callErrorText(failure))
    }
  }
  const installed = (answer: Installed) =>
    said(answer.enabled ? text.installedNotice(answer.name) : text.installedOff(answer.name))
  const addCatalog = async (event: FormEvent) => {
    event.preventDefault()
    setMarketplaceProblem(null)
    if (marketplaceAddress.trim() === '') return
    try {
      const added = await addMarketplace.mutateAsync({ address: marketplaceAddress.trim() })
      setMarketplaceAddress('')
      setNotice(text.marketplaceAdded(added.name))
      void queryClient.invalidateQueries({ queryKey: trpc.accountSkills.marketplaces.queryKey() })
    } catch (failure) {
      setMarketplaceProblem(callErrorText(failure))
    }
  }
  const dropCatalog = async (marketplace: Marketplace) => {
    setMarketplaceProblem(null)
    try {
      await removeMarketplace.mutateAsync({ marketplaceId: marketplace.id })
      void queryClient.invalidateQueries({ queryKey: trpc.accountSkills.marketplaces.queryKey() })
    } catch (failure) {
      setMarketplaceProblem(callErrorText(failure))
    }
  }

  const data = list.data
  const counter = data ? text.counter(data.counts.enabled, data.limits.enabled) : null
  const full = data ? data.counts.enabled >= data.limits.enabled : false
  const shown = data?.skills.filter((skill) => !skill.catalog || skill.enabled) ?? []
  const catalog = data?.skills.filter((skill) => skill.catalog && !skill.enabled) ?? []
  const installedNames = new Set(
    data?.skills.filter((skill) => skill.id !== null).map((s) => s.name),
  )
  const busy = switchSkill.isPending

  const header = (
    <Section
      heading="h1"
      title={text.title}
      note={nbsp(text.note)}
      aside={
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          <Button
            variant="outlined"
            startIcon={<AppIcon name="plus" size={16} />}
            onClick={() => setInstalling({ kind: 'address' })}
            sx={{ minHeight: 40 }}
          >
            {text.addByLink}
          </Button>
          <Button
            variant="outlined"
            startIcon={<AppIcon name="upload" size={16} />}
            onClick={() => setInstalling({ kind: 'file' })}
            sx={{ minHeight: 40 }}
          >
            {text.addFromFile}
          </Button>
        </Box>
      }
    >
      <Box
        sx={{ px: { xs: 2, sm: 2.75 }, py: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}
      >
        {counter ? (
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {counter}
          </Typography>
        ) : null}
        {full && data ? (
          <Typography variant="body2" color="text.secondary">
            {nbsp(text.enabledFull(data.limits.enabled))}
          </Typography>
        ) : null}
        {notice ? (
          <Alert severity="success" role="status" onClose={() => setNotice(null)}>
            {notice}
          </Alert>
        ) : null}
        {problem ? (
          <Alert severity="error" role="alert" onClose={() => setProblem(null)}>
            {problem}
          </Alert>
        ) : null}
      </Box>
    </Section>
  )

  let body: ReactNode
  if (list.isError)
    body = (
      <Alert severity="error" role="alert">
        {text.loadFailed}
      </Alert>
    )
  else if (!data)
    body = (
      <Box role="status" aria-label={text.loading}>
        <Skeleton height={64} />
        <Skeleton height={64} />
        <Skeleton height={64} />
      </Box>
    )
  else
    body = (
      <>
        <Section title={text.installed}>
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {shown.map((skill) => (
              <Box component="li" key={skill.id ?? `builtin:${skill.name}`} sx={rowSx}>
                <SkillWords skill={skill} />
                <Switch
                  checked={skill.enabled}
                  disabled={busy || (!skill.enabled && full)}
                  onChange={(event) => void toggle(skill, event.target.checked)}
                  slotProps={{ input: { 'aria-label': text.switchLabel(skill.title) } }}
                  sx={{ flexShrink: 0, mt: 0.25 }}
                />
                <RowMenu
                  skill={skill}
                  onOpen={() => setViewing(skill)}
                  onUpdate={() => setUpdating(skill)}
                  onHistory={() => setHistory(skill)}
                  onRemove={() => {
                    setRemoveError(null)
                    setRemoving(skill)
                  }}
                />
              </Box>
            ))}
          </Box>
          {shown.every((skill) => skill.id === null) ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ px: { xs: 2, sm: 2.75 }, py: 1.75 }}
            >
              {nbsp(text.installedEmpty)}
            </Typography>
          ) : null}
        </Section>

        <Section title={text.catalog} note={text.catalogNote}>
          {catalog.length === 0 ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ px: { xs: 2, sm: 2.75 }, py: 1.75 }}
            >
              {text.catalogEmpty}
            </Typography>
          ) : (
            <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
              {catalog.map((skill) => (
                <Box component="li" key={skill.name} sx={rowSx}>
                  <SkillWords skill={skill} />
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={busy || full}
                    aria-label={`${text.enable} «${skill.title}»`}
                    onClick={() => void toggle(skill, true)}
                    sx={{ flexShrink: 0, minHeight: 36 }}
                  >
                    {text.enable}
                  </Button>
                </Box>
              ))}
            </Box>
          )}
        </Section>
      </>
    )

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, minWidth: 0 }}>
      {header}
      {body}

      <Section title={text.marketplaces} note={nbsp(text.marketplacesNote)}>
        <Box
          sx={{ px: { xs: 2, sm: 2.75 }, py: 2, display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          <TextField
            size="small"
            type="search"
            label={text.search}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <AppIcon name="search" size={16} />
                  </InputAdornment>
                ),
              },
            }}
            sx={{ maxWidth: 420 }}
          />
          {marketplaces.isError ? (
            <Alert severity="error">
              {callErrorText(marketplaces.error, text.marketplacesFailed)}
            </Alert>
          ) : !marketplaces.data ? (
            <Box role="status" aria-label={text.loading}>
              <Skeleton height={48} />
              <Skeleton height={48} />
            </Box>
          ) : (
            marketplaces.data.map((marketplace) => (
              <MarketplaceBlock
                key={marketplace.id}
                marketplace={marketplace}
                query={query}
                installedNames={installedNames}
                busy={removeMarketplace.isPending}
                onInstall={(item) =>
                  setInstalling({
                    kind: 'marketplace',
                    marketplaceId: marketplace.id,
                    plugin: item.plugin,
                    ...(item.path !== undefined ? { path: item.path } : {}),
                    name: item.name,
                  })
                }
                onRemove={() => void dropCatalog(marketplace)}
              />
            ))
          )}
          <Box
            component="form"
            noValidate
            aria-label={text.addMarketplace}
            onSubmit={(event) => void addCatalog(event)}
            sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 1.25 }}
          >
            <TextField
              size="small"
              label={text.marketplaceAddress}
              helperText={text.marketplaceAddressHelp}
              value={marketplaceAddress}
              type="url"
              onChange={(event) => setMarketplaceAddress(event.target.value)}
              slotProps={{
                htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' },
              }}
              sx={{ flex: '1 1 280px', minWidth: 0 }}
            />
            <Button
              type="submit"
              variant="outlined"
              loading={addMarketplace.isPending}
              disabled={marketplaceAddress.trim() === ''}
              sx={{ minHeight: 40 }}
            >
              {text.addMarketplace}
            </Button>
          </Box>
          {marketplaceProblem ? (
            <Alert severity="error" role="alert">
              {marketplaceProblem}
            </Alert>
          ) : null}
        </Box>
      </Section>

      <InstallSkillDialog
        target={installing}
        onClose={() => setInstalling(null)}
        onInstalled={installed}
      />
      <ViewSkillDialog skill={viewing} onClose={() => setViewing(null)} />
      <UpdateSkillDialog
        key={updating?.id ?? 'none'}
        skill={updating}
        onClose={() => setUpdating(null)}
        onUpdated={(skill) => said(text.updated(skill.title))}
      />
      <HistorySkillDialog
        skill={history}
        onClose={() => setHistory(null)}
        onRestored={(skill) => said(text.restored(skill.title))}
      />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing ? text.removeTitle(removing.title) : ''}
        busy={removeSkill.isPending}
        error={removeError}
        keepLabel={text.keep}
        confirmLabel={text.remove}
        danger
        onConfirm={() => void confirmRemove()}
      >
        <Typography sx={{ mt: 1.5 }}>{nbsp(text.removeBody)}</Typography>
      </ConfirmDialog>
    </Box>
  )
}

/** One marketplace: its name and address, its skills for the search, «Установить» on each. */
function MarketplaceBlock({
  marketplace,
  query,
  installedNames,
  busy,
  onInstall,
  onRemove,
}: {
  marketplace: Marketplace
  query: string
  installedNames: ReadonlySet<string>
  busy: boolean
  onInstall: (item: ReturnType<typeof marketplaceSkills>[number]) => void
  onRemove: () => void
}) {
  const items = marketplaceSkills(marketplace, query)
  const visible = items.slice(0, MARKETPLACE_SHOWN)
  return (
    <Box
      role="group"
      aria-label={marketplace.name}
      sx={{ border: 1, borderColor: 'divider', borderRadius: '12px', minWidth: 0 }}
    >
      <Box
        sx={{
          px: 2,
          py: 1.25,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 1,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Box sx={{ flex: '1 1 200px', minWidth: 0 }}>
          <Typography component="h3" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
            {marketplace.name}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            <Link
              href={marketplace.url}
              target="_blank"
              rel="noopener noreferrer"
              color="inherit"
              translate="no"
            >
              {marketplace.repo}
            </Link>
            {marketplace.platform ? ` · ${text.platformMarketplace}` : null}
          </Typography>
          {marketplace.stale ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 0.25, fontStyle: 'italic' }}
            >
              {text.stale}
            </Typography>
          ) : null}
        </Box>
        {marketplace.platform ? null : (
          <Button
            size="small"
            color="error"
            disabled={busy}
            onClick={onRemove}
            sx={{ minHeight: 36 }}
          >
            {text.removeMarketplace}
          </Button>
        )}
      </Box>
      {items.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1.5 }}>
          {marketplace.plugins.length === 0 ? text.marketplaceEmpty : text.nothingFound}
        </Typography>
      ) : (
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {visible.map((item) => (
            <Box
              component="li"
              key={`${item.plugin}/${item.path ?? ''}`}
              sx={{ ...rowSx, px: 2, py: 1.25 }}
            >
              <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75 }}>
                  <Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere' }} translate="no">
                    {item.name}
                  </Typography>
                  {item.plugin !== item.name ? (
                    <Typography variant="body2" color="text.secondary" translate="no">
                      {item.plugin}
                    </Typography>
                  ) : null}
                </Box>
                {item.description ? (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                    {item.description}
                  </Typography>
                ) : null}
              </Box>
              {installedNames.has(item.name) ? (
                <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0, mt: 0.5 }}>
                  {text.installedMark}
                </Typography>
              ) : (
                <Button
                  size="small"
                  variant="outlined"
                  aria-label={`${text.install} ${item.name}`}
                  onClick={() => onInstall(item)}
                  sx={{ flexShrink: 0, minHeight: 36 }}
                >
                  {text.install}
                </Button>
              )}
            </Box>
          ))}
        </Box>
      )}
      {items.length > MARKETPLACE_SHOWN ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1.25 }}>
          {text.firstShown(MARKETPLACE_SHOWN)}
        </Typography>
      ) : null}
    </Box>
  )
}
