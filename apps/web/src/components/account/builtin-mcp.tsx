'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import Skeleton from '@mui/material/Skeleton'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useState, type FormEvent, type ReactNode } from 'react'

import { callErrorText } from '@/components/chat/call-error'
import { nbsp } from '@/lib/nbsp'
import { useTRPC } from '@/trpc/client'

// «Настройки → Встроенные MCP» (docs/plan/99-vk-community.md, ВК15; owner's words of 27.11.2026:
// «давай добавим в настройки раздел buildin mcp и там на vk сделаем тогл и если да, то нужно ввести
// ключ авторизации вк и постепенно это будет пополняться, если галочка снята, тогда даже в список mcp
// серверов не входит»): the built-in servers of Радити, each with its switch. A server that is off
// is not in a chat at all. «ВКонтакте» turns on with a key of a community: the switch opens its
// form, and the key, checked against VK, turns it on. The server checks every change again.

export const builtinMcpText = Object.freeze({
  title: 'Встроенные MCP',
  note: 'Инструменты Радити, которые агент получает, только когда вы их включили. Выключенный сервер агенту не виден ни в одном чате.',
  readOnly: 'Включать и выключать встроенные MCP могут владелец и администраторы.',
  switchLabel: (title: string) => `Встроенный MCP «${title}»`,
  keyTitle: 'Ключ доступа сообщества',
  keyHelp:
    'В группе ВКонтакте: «Управление» → «Дополнительно» → «Работа с API» → «Создать ключ». Отметьте права «Управление сообществом» и «Стена». Ключ уходит в защищённое хранилище и больше не показывается; агент его не видит.',
  connect: 'Подключить группу',
  addGroup: 'Добавить группу',
  cancel: 'Отмена',
  disconnect: 'Отключить',
  groupsTitle: 'Подключённые группы',
  closed: 'закрытая — агент не читает её стену',
  refused: 'ВКонтакте не принимает ключ — подключите группу заново',
  noNotices:
    'О новых комментариях не сообщаем: у ключа нет права «Управление сообществом». Чтобы получать уведомления, подключите группу ключом с этим правом',
  keyEmpty: 'Вставьте ключ доступа сообщества.',
  full: 'Подключено максимальное число групп.',
  loadFailed: 'Не удалось загрузить встроенные MCP. Обновите страницу.',
  loading: 'Загружаем встроенные MCP',
})

export interface BuiltinMcpView {
  servers: {
    server: 'vk'
    title: string
    summary: string
    needsKey: boolean
    enabled: boolean
    communities: {
      id: string
      name: string
      url: string
      closed: boolean
      refused: boolean
      notices: boolean
    }[]
  }[]
  canManage: boolean
  workspaceId: string | null
  communitiesLeft: number
}

function Card({ children }: { children: ReactNode }) {
  return (
    <Box component="section" sx={{ border: 1, borderColor: 'divider', borderRadius: '14px' }}>
      <Box sx={{ px: { xs: 2, sm: 2.75 }, py: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Typography component="h1" sx={{ fontSize: 17, fontWeight: 600 }}>
          {builtinMcpText.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 720 }}>
          {nbsp(builtinMcpText.note)}
        </Typography>
      </Box>
      {children}
    </Box>
  )
}

/** «Настройки → Встроенные MCP» of the user's personal workspace. */
export function WorkspaceBuiltinMcp() {
  const trpc = useTRPC()
  const list = useQuery(trpc.builtinMcp.list.queryOptions({}))
  if (list.data) return <BuiltinMcp initial={list.data} />
  return (
    <Card>
      {list.isError ? (
        <Alert severity="error" sx={{ m: 2 }}>
          {builtinMcpText.loadFailed}
        </Alert>
      ) : (
        <Box sx={{ p: 2 }} aria-label={builtinMcpText.loading} role="status">
          <Skeleton height={64} />
        </Box>
      )}
    </Card>
  )
}

export function BuiltinMcp({ initial }: { initial: BuiltinMcpView }) {
  const trpc = useTRPC()
  const switchServer = useMutation(trpc.builtinMcp.switch.mutationOptions())
  const connect = useMutation(trpc.builtinMcp.vkConnect.mutationOptions())
  const disconnect = useMutation(trpc.builtinMcp.vkDisconnect.mutationOptions())
  const [view, setView] = useState(initial)
  const workspaceId = view.workspaceId ?? undefined
  // The server whose key form is open: its switch was turned on, or «Добавить группу» pressed.
  const [keyFor, setKeyFor] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const formId = useId()
  const busy = switchServer.isPending || connect.isPending || disconnect.isPending

  const run = async (call: () => Promise<BuiltinMcpView>) => {
    setProblem(null)
    try {
      setView(await call())
      return true
    } catch (failure) {
      setProblem(callErrorText(failure))
      return false
    }
  }

  const toggle = async (server: BuiltinMcpView['servers'][number], enabled: boolean) => {
    // On without a working key: the key's form opens, the switch moves once the key is taken.
    if (enabled && server.needsKey && !server.communities.some((group) => !group.refused)) {
      setProblem(null)
      setKeyFor(server.server)
      return
    }
    if (!enabled && keyFor === server.server) setKeyFor(null)
    await run(() =>
      switchServer.mutateAsync({
        ...(workspaceId ? { workspaceId } : {}),
        server: server.server,
        enabled,
      }),
    )
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (token.trim() === '') {
      setProblem(builtinMcpText.keyEmpty)
      return
    }
    const done = await run(() =>
      connect.mutateAsync({ ...(workspaceId ? { workspaceId } : {}), token: token.trim() }),
    )
    if (done) {
      setToken('')
      setKeyFor(null)
    }
  }

  return (
    <Card>
      {!view.canManage && (
        <Alert severity="info" sx={{ m: 2 }}>
          {builtinMcpText.readOnly}
        </Alert>
      )}
      {problem && (
        <Alert severity="error" sx={{ m: 2 }} role="alert">
          {problem}
        </Alert>
      )}
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {view.servers.map((server) => {
          const open = keyFor === server.server
          return (
            <Box
              component="li"
              key={server.server}
              sx={{
                px: { xs: 2, sm: 2.75 },
                py: 2,
                '& + &': { borderTop: 1, borderColor: 'divider' },
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 600 }}>{server.title}</Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                    {nbsp(server.summary)}
                  </Typography>
                </Box>
                <Switch
                  checked={server.enabled || open}
                  disabled={!view.canManage || busy}
                  onChange={(event) => void toggle(server, event.target.checked)}
                  slotProps={{ input: { 'aria-label': builtinMcpText.switchLabel(server.title) } }}
                />
              </Box>

              {server.communities.length > 0 && (
                <Box sx={{ mt: 1.5 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {builtinMcpText.groupsTitle}
                  </Typography>
                  <Box component="ul" sx={{ listStyle: 'none', m: 0, mt: 0.5, p: 0 }}>
                    {server.communities.map((group) => (
                      <Box
                        component="li"
                        key={group.id}
                        sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}
                      >
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Link href={group.url} target="_blank" rel="noopener noreferrer">
                            {group.name}
                          </Link>
                          {(group.closed || group.refused) && (
                            <Typography
                              variant="caption"
                              color={group.refused ? 'error' : 'text.secondary'}
                              sx={{ display: 'block' }}
                            >
                              {group.refused ? builtinMcpText.refused : builtinMcpText.closed}
                            </Typography>
                          )}
                          {!group.refused && !group.notices && (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ display: 'block' }}
                            >
                              {builtinMcpText.noNotices}
                            </Typography>
                          )}
                        </Box>
                        {view.canManage && (
                          <Button
                            size="small"
                            color="inherit"
                            disabled={busy}
                            onClick={() =>
                              void run(() =>
                                disconnect.mutateAsync({
                                  ...(workspaceId ? { workspaceId } : {}),
                                  communityId: group.id,
                                }),
                              )
                            }
                          >
                            {builtinMcpText.disconnect}
                          </Button>
                        )}
                      </Box>
                    ))}
                  </Box>
                  {view.canManage && !open && server.enabled && (
                    <Button
                      size="small"
                      sx={{ mt: 0.5 }}
                      disabled={busy || view.communitiesLeft === 0}
                      onClick={() => {
                        setProblem(null)
                        setKeyFor(server.server)
                      }}
                    >
                      {view.communitiesLeft === 0 ? builtinMcpText.full : builtinMcpText.addGroup}
                    </Button>
                  )}
                </Box>
              )}

              {open && view.canManage && (
                <Box
                  component="form"
                  id={formId}
                  onSubmit={(event) => void submit(event)}
                  sx={{ mt: 2, display: 'grid', gap: 1.5, maxWidth: 560 }}
                >
                  <TextField
                    label={builtinMcpText.keyTitle}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    type="password"
                    autoComplete="off"
                    size="small"
                    autoFocus
                    helperText={nbsp(builtinMcpText.keyHelp)}
                    slotProps={{ htmlInput: { spellCheck: false } }}
                  />
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <Button type="submit" variant="contained" disabled={busy}>
                      {builtinMcpText.connect}
                    </Button>
                    <Button
                      color="inherit"
                      disabled={busy}
                      onClick={() => {
                        setKeyFor(null)
                        setToken('')
                        setProblem(null)
                      }}
                    >
                      {builtinMcpText.cancel}
                    </Button>
                  </Box>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    </Card>
  )
}
