'use client'

import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import {
  todoListReadsRussian,
  todoProgressOf,
  type AgentTodoItem,
  type AgentTodoList,
  type ChatTodo,
  type TodoProgress,
} from '@repo/domain/tasks/agent-todo'
import {
  useCallback,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'

import { AppIcon } from '@/components/application/app-icon'

import { atWorkPulse } from './chat-motion'
import { todoText } from './chat-texts'
import { offScreen } from './composer'
import { RESULTS_WIDTH } from './results-card'

// «План работы» (docs/plan/89-agent-todos.md, §6): the agent's plan of its work, as its to-do tool
// left it. From `lg` a card over «Результаты» in the column beside the chat, in every state of the
// plan; where the column does not fit, one line over the field while the agent works on it. The
// same ordered list stands in both and in «Ход работы». Nothing here takes the focus (§6.4): the
// focus left in the open list over the field goes back to the line that opened it — on Esc, and
// when the list of a later turn folds it away.

/** About seven items of one line: the list scrolls in itself past them (§6.1). */
const LIST_HEIGHT = 196

/**
 * A list that scrolls in itself: a region of its own name the keyboard reaches and scrolls, as
 * «Ход работы» is (axe `scrollable-region-focusable`; Safari does not give such a box the focus).
 */
const scrollingList = {
  role: 'region',
  'aria-label': todoText.steps,
  tabIndex: 0,
} as const
const scrollingListSx = {
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
} as const

/** How the items at work are drawn: the plan of the turn at work, a plan the work left, history. */
export type TodoListMode = 'working' | 'paused' | 'snapshot'

type Mark = 'ahead' | 'now' | 'busy' | 'paused' | 'done' | 'skipped'

function markOf(item: AgentTodoItem, current: boolean, mode: TodoListMode): Mark {
  switch (item.status) {
    case 'completed':
      return 'done'
    case 'cancelled':
      return 'skipped'
    case 'pending':
      return 'ahead'
    case 'in_progress':
      // Unfinished is never drawn as done (§3, «Конец работы»): a pause, «не закончено».
      if (mode === 'paused') return 'paused'
      return mode === 'working' && current ? 'now' : 'busy'
  }
}

const statusWords: Record<Mark, string> = {
  ahead: todoText.status.pending,
  now: todoText.status.in_progress,
  busy: todoText.status.in_progress,
  paused: todoText.status.unfinished,
  done: todoText.status.completed,
  skipped: todoText.status.cancelled,
}

/** The sign before an item: a circle ahead, a dot at work, a pause, a check, a dash. */
function MarkSign({ mark }: { mark: Mark }) {
  const box = {
    flex: 'none',
    width: 16,
    height: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as const
  switch (mark) {
    case 'ahead':
      return (
        <Box aria-hidden sx={box}>
          <Box
            sx={{
              width: 11,
              height: 11,
              borderRadius: '50%',
              border: '1.5px solid',
              borderColor: 'text.secondary',
            }}
          />
        </Box>
      )
    case 'now':
    case 'busy':
      return (
        <Box aria-hidden sx={box} data-todo-mark={mark}>
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              bgcolor: 'primary.main',
              ...(mark === 'now' ? atWorkPulse : {}),
            }}
          />
        </Box>
      )
    case 'paused':
      return (
        <Box aria-hidden sx={{ ...box, gap: '3px' }} data-todo-mark={mark}>
          <Box sx={{ width: 3, height: 10, borderRadius: '1px', bgcolor: 'text.secondary' }} />
          <Box sx={{ width: 3, height: 10, borderRadius: '1px', bgcolor: 'text.secondary' }} />
        </Box>
      )
    case 'done':
      return (
        <Box aria-hidden sx={{ ...box, color: 'success.main' }}>
          <AppIcon name="check" size={14} />
        </Box>
      )
    case 'skipped':
      return (
        <Box aria-hidden sx={box}>
          <Box sx={{ width: 10, height: '1.5px', bgcolor: 'text.secondary' }} />
        </Box>
      )
  }
}

function TodoItemLine({
  item,
  current,
  mode,
}: {
  item: AgentTodoItem
  current: boolean
  mode: TodoListMode
}) {
  const mark = markOf(item, current, mode)
  const over = mark === 'done' || mark === 'skipped'
  const now = mark === 'now'
  return (
    <Box
      component="li"
      aria-label={todoText.item(item.text, statusWords[mark])}
      aria-current={now ? 'step' : undefined}
      data-todo-item={mark}
      sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, py: 0.5, minWidth: 0 }}
    >
      <MarkSign mark={mark} />
      <Box
        component="span"
        sx={{
          flex: '1 1 auto',
          minWidth: 0,
          fontSize: 13,
          lineHeight: '20px',
          overflowWrap: 'anywhere',
          // Three lines of an item at most; the rest is cut short.
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          fontWeight: now || (current && mode === 'snapshot') ? 600 : 400,
          color: over ? 'text.secondary' : 'text.primary',
          textDecoration: over ? 'line-through' : 'none',
        }}
      >
        {item.text}
      </Box>
      {now || mark === 'paused' ? (
        <Box
          component="span"
          aria-hidden
          sx={{
            flex: 'none',
            fontSize: 12,
            lineHeight: '20px',
            color: now ? 'primary.main' : 'text.secondary',
            whiteSpace: 'nowrap',
          }}
        >
          {now ? todoText.current : todoText.unfinished}
        </Box>
      ) : null}
    </Box>
  )
}

const noteSx = { m: 0, py: 0.5, pl: 3, fontSize: 12, lineHeight: '18px', color: 'text.secondary' }

/**
 * The items of a plan in the agent's order, with what the driver left out of a long one: the
 * completed ones of its head above, the rest of its tail below (ТД3).
 */
export function TodoList({ list, mode }: { list: AgentTodoList; mode: TodoListMode }) {
  const current = todoProgressOf(list).current
  const omitted = list.omitted
  return (
    <>
      {omitted && omitted.completed > 0 ? (
        <Typography sx={noteSx}>{todoText.hiddenDone(omitted.completed)}</Typography>
      ) : null}
      <Box component="ol" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid' }}>
        {list.items.map((item, index) => (
          // The agent's items have no id: an item is its place in the list (§2).
          <TodoItemLine key={index} item={item} current={index === current} mode={mode} />
        ))}
      </Box>
      {omitted && omitted.other > 0 ? (
        <Typography sx={noteSx}>{todoText.more(omitted.other)}</Typography>
      ) : null}
    </>
  )
}

/** The step a list not in Russian is at: the one after the completed, the last when all are. */
export const todoStepOf = (progress: TodoProgress): number =>
  progress.done < progress.total ? progress.done + 1 : progress.total

/** «Сделано 2 из 5», or «Шаг 3 из 5» for a list whose words the client is not shown (ТД11). */
export const todoCountOf = (progress: TodoProgress, russian: boolean): string =>
  russian
    ? todoText.done(progress.done, progress.total)
    : todoText.step(todoStepOf(progress), progress.total)

export interface TodoHead {
  /** The words of the head: «План работы» or the state of the plan. */
  label: string
  /** The count beside them; null — none. */
  count: string | null
  /** The card starts folded into its head, until the client opens it. */
  collapsed: boolean
  /** The items are shown: the agent wrote them in Russian (ТД11). */
  items: boolean
}

/**
 * The head of the card by the state of the plan (§6.1). `waiting` — the chat waits for the
 * client's answer to a question of the agent.
 */
export function todoHeadOf(todo: ChatTodo, waiting: boolean): TodoHead {
  const progress = todoProgressOf(todo)
  const russian = todoListReadsRussian(todo.items)
  if (progress.abandoned)
    return { label: todoText.head.abandoned, count: null, collapsed: true, items: russian }
  const count = todoCountOf(progress, russian)
  const open = (label: string): TodoHead => ({ label, count, collapsed: false, items: russian })
  switch (todo.state) {
    case 'working':
      return open(todoText.title)
    case 'carried':
      return open(todoText.head.carried)
    case 'stopped':
      return open(todoText.head.stopped)
    case 'failed':
      return open(todoText.head.failed)
    case 'ended':
      // A plan done to its end folds until the next turn; one left halfway stays open.
      if (progress.done === progress.total)
        return {
          label: todoText.head.allDone,
          count: todoText.of(progress.done, progress.total),
          collapsed: true,
          items: russian,
        }
      return open(waiting ? todoText.head.waiting : todoText.title)
  }
}

/**
 * What the client chose for the plan of one turn, for the life of the page: by `taskId:turn`, so
 * the plan of the next turn starts as its state says.
 */
const collapsedChoices = new Map<string, boolean>()

function useCollapsed(key: string, byDefault: boolean): [boolean, () => void] {
  const [, redraw] = useReducer((count: number) => count + 1, 0)
  const collapsed = collapsedChoices.get(key) ?? byDefault
  const toggle = useCallback(() => {
    collapsedChoices.set(key, !(collapsedChoices.get(key) ?? byDefault))
    redraw()
  }, [key, byDefault])
  return [collapsed, toggle]
}

function Chevron({ up }: { up: boolean }) {
  return (
    <Box
      aria-hidden
      sx={{ display: 'flex', transform: up ? 'rotate(180deg)' : 'none', color: 'text.secondary' }}
    >
      <AppIcon name="down" size={16} />
    </Box>
  )
}

/** The card of the plan in the column beside the chat, over «Результаты» (§6.1). */
export function TodoCard({
  taskId,
  todo,
  waiting,
}: {
  taskId: string
  todo: ChatTodo
  /** The chat waits for the client's answer to the agent's question. */
  waiting: boolean
}) {
  const head = todoHeadOf(todo, waiting)
  const progress = todoProgressOf(todo)
  const spoken = progress.abandoned ? '' : todoCountOf(progress, head.items)
  const [collapsed, toggle] = useCollapsed(`${taskId}:${todo.turn}`, head.collapsed)
  const titleId = useId()
  const listId = useId()
  return (
    <Box
      component="section"
      aria-labelledby={titleId}
      sx={{
        width: RESULTS_WIDTH,
        p: 1,
        border: 1,
        borderColor: 'divider',
        borderRadius: '16px',
        bgcolor: 'background.paper',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 1, minHeight: 32 }}>
        <Typography
          component="h2"
          id={titleId}
          sx={{
            flex: '1 1 auto',
            minWidth: 0,
            fontSize: 13,
            fontWeight: 500,
            lineHeight: '18px',
            color: 'text.secondary',
          }}
        >
          {/* A state in place of the title: a screen reader hears whose state it is. */}
          {head.label === todoText.title ? null : (
            <>
              <Box component="span" sx={offScreen}>
                {`${todoText.title}:`}
              </Box>{' '}
            </>
          )}
          {head.label}
        </Typography>
        {head.count === null ? null : (
          <Typography
            component="span"
            sx={{ flex: 'none', fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap' }}
          >
            {head.count}
          </Typography>
        )}
        {head.items ? (
          <IconButton
            aria-label={collapsed ? todoText.expand : todoText.collapse}
            aria-expanded={!collapsed}
            aria-controls={listId}
            onClick={toggle}
            sx={{ flex: 'none', width: 32, height: 32, borderRadius: '8px' }}
          >
            <Chevron up={!collapsed} />
          </IconButton>
        ) : (
          <Box sx={{ width: 8 }} />
        )}
      </Box>
      {head.items ? (
        <Box
          id={listId}
          data-todo-list=""
          {...scrollingList}
          sx={{
            ...scrollingListSx,
            display: collapsed ? 'none' : 'block',
            maxHeight: LIST_HEIGHT,
            borderRadius: '8px',
            px: 1,
            pt: 0.25,
          }}
        >
          <TodoList list={todo} mode={todo.state === 'working' ? 'working' : 'paused'} />
        </Box>
      ) : null}
      {/* Says the count as it changes, not each rewrite of the list (§6.4) — nor the end of a turn
          that finished its plan, which only writes the count of the head shorter. */}
      <Box role="status" aria-live="polite" sx={offScreen}>
        {spoken}
      </Box>
    </Box>
  )
}

/** The plan stands over the field only while the agent works on it, or goes on with it (§6.2). */
export const todoStripShows = (todo: ChatTodo): boolean =>
  todo.state === 'working' || todo.state === 'carried'

/**
 * The plan over the field where the column beside the chat does not fit (§6.2): one line while
 * the agent works — the count and the item at work —, opened upwards into the list by a press.
 * It starts folded, and nothing but its own press opens it: sending a message does not. The chat
 * mounts it only while `todoStripShows`; a press opens the plan of its turn, so the list a later
 * turn writes starts folded — without a remount, which would drop the focus on the line.
 */
export function TodoStrip({ todo }: { todo: ChatTodo }) {
  const [openTurn, setOpenTurn] = useState<number | null>(null)
  const open = openTurn === todo.turn
  const listId = useId()
  const list = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  // The list of a later turn starts folded; the focus inside the list that folds away goes to the
  // line that opened it, not to the page — before paint, while the list still holds it.
  useLayoutEffect(() => {
    if (!open && list.current?.contains(document.activeElement)) button.current?.focus()
  }, [open])
  if (!todoStripShows(todo)) return null
  const progress = todoProgressOf(todo)
  const russian = todoListReadsRussian(todo.items)
  const working = todo.state === 'working'
  const count = todoCountOf(progress, russian)
  const current = russian && progress.current !== null ? todo.items[progress.current]!.text : null
  const line = progress.abandoned
    ? todoText.head.abandoned
    : working
      ? todoText.strip(count, current)
      : todoText.after(todoText.head.carried, count)
  const opens = russian && todo.items.length > 0
  // The sign of the item at work: it breathes while this turn works on it, a pause when the plan
  // is the one an earlier turn left.
  const sign = <MarkSign mark={progress.current === null ? 'ahead' : working ? 'now' : 'paused'} />
  const words = (
    <Box
      component="span"
      sx={{
        flex: '1 1 auto',
        minWidth: 0,
        fontSize: 14,
        textAlign: 'left',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {line}
    </Box>
  )
  const lineSx = {
    width: '100%',
    height: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 1,
    px: 1.5,
    color: 'text.primary',
  } as const
  return (
    <Box
      component="section"
      aria-label={todoText.title}
      data-todo-strip=""
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== 'Escape' || !open) return
        // The focus does not stay in a list that folds away: it goes to the line that opened it.
        if (list.current?.contains(document.activeElement)) button.current?.focus()
        setOpenTurn(null)
      }}
      sx={{
        mb: 1,
        border: 1,
        borderColor: 'divider',
        borderRadius: '12px',
        bgcolor: 'background.paper',
        overflow: 'hidden',
      }}
    >
      {opens ? (
        <Box
          id={listId}
          ref={list}
          data-todo-list=""
          {...scrollingList}
          sx={{
            ...scrollingListSx,
            display: open ? 'block' : 'none',
            maxHeight: '40vh',
            px: 1.5,
            pt: 1,
            pb: 0.5,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <TodoList list={todo} mode={working ? 'working' : 'paused'} />
        </Box>
      ) : null}
      {opens ? (
        <ButtonBase
          ref={button}
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpenTurn(open ? null : todo.turn)}
          sx={{
            ...lineSx,
            '&:hover': { bgcolor: 'var(--mui-palette-action-hover)' },
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: -2,
            },
          }}
        >
          {sign}
          {words}
          <Chevron up={open} />
        </ButtonBase>
      ) : (
        <Box sx={lineSx}>
          {sign}
          {words}
        </Box>
      )}
      <Box role="status" aria-live="polite" sx={offScreen}>
        {progress.abandoned ? '' : count}
      </Box>
    </Box>
  )
}
