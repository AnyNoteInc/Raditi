'use client'

import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Snackbar from '@mui/material/Snackbar'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useId, useState, type Ref } from 'react'

import { AppIcon } from '@/components/application/app-icon'
import { callErrorText } from '@/components/chat/call-error'
import { useTRPC } from '@/trpc/client'

import type { ScheduleDetail, ScheduleItem } from './schedule-model'
import { scheduleRowTexts } from './schedule-texts'

/** A task as its actions need it: from «Ваши» or from its own page. */
type Task = Pick<ScheduleItem | ScheduleDetail, 'id' | 'name' | 'enabled'>

/** What an action says when it ends, for a moment at the bottom of the screen. */
export type ScheduleNotice = { text: string } | null

/**
 * The switch, «Запустить сейчас» and «Удалить» of a task (Зп5, Зп6, Зп23, Зп24): each reads «Ваши»
 * and the page of the task again when it ends. «Запустить сейчас» opens the chat of its run; a
 * refusal is told in the server's words. What a deletion says, and where the focus goes after it,
 * is the caller's: the row is gone from «Ваши», and the page of the task is left.
 */
export function useScheduleActions(onNotice: (notice: ScheduleNotice) => void) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const settled = (scheduleId: string) => {
    void queryClient.invalidateQueries({ queryKey: trpc.schedule.list.queryKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.schedule.get.queryKey({ scheduleId }) })
  }
  const setEnabled = useMutation(trpc.schedule.setEnabled.mutationOptions())
  const runNow = useMutation(trpc.schedule.runNow.mutationOptions())
  const remove = useMutation(trpc.schedule.delete.mutationOptions())
  return {
    setEnabled,
    runNow,
    remove,
    toggle(task: Task, enabled: boolean) {
      setEnabled.mutate(
        { scheduleId: task.id, enabled },
        {
          onSuccess: (saved) => {
            queryClient.setQueryData(trpc.schedule.get.queryKey({ scheduleId: task.id }), saved)
            onNotice({
              text: enabled ? scheduleRowTexts.resumed : scheduleRowTexts.pausedNotice,
            })
          },
          onError: (error) => onNotice({ text: callErrorText(error) }),
          onSettled: () => settled(task.id),
        },
      )
    },
    start(task: Task) {
      runNow.mutate(
        { scheduleId: task.id },
        {
          onSuccess: ({ taskId }) => router.push(`/chats/${taskId}`),
          onError: (error) => onNotice({ text: callErrorText(error) }),
          onSettled: () => settled(task.id),
        },
      )
    },
    async delete(task: Task): Promise<boolean> {
      try {
        await remove.mutateAsync({ scheduleId: task.id })
        void queryClient.invalidateQueries({ queryKey: trpc.schedule.list.queryKey() })
        // A page of the task that is open keeps it until it is left, and drops it then: dropped
        // under its eyes, the page would read it again and show «Задачи уже нет» first.
        queryClient.removeQueries({
          queryKey: trpc.schedule.get.queryKey({ scheduleId: task.id }),
          type: 'inactive',
        })
        return true
      } catch (error) {
        onNotice({ text: callErrorText(error) })
        return false
      }
    },
  }
}

export type ScheduleActions = ReturnType<typeof useScheduleActions>

/** The switch of a task, named by it (Зп5): on — it runs by its schedules. */
export function ScheduleSwitch({ task, actions }: { task: Task; actions: ScheduleActions }) {
  const busy = actions.setEnabled.isPending && actions.setEnabled.variables?.scheduleId === task.id
  return (
    <Switch
      checked={busy ? (actions.setEnabled.variables?.enabled ?? task.enabled) : task.enabled}
      disabled={busy}
      onChange={(event) => actions.toggle(task, event.target.checked)}
      slotProps={{ input: { 'aria-label': scheduleRowTexts.switchLabel(task.name) } }}
    />
  )
}

/** «Удалить задачу «…»? Чаты прошлых запусков останутся.» (Зп5, Зп23). */
export function ScheduleDeleteDialog({
  task,
  open,
  pending,
  onConfirm,
  onClose,
}: {
  task: Pick<Task, 'name'>
  open: boolean
  pending: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const titleId = useId()
  const textId = useId()
  return (
    <Dialog
      open={open}
      onClose={pending ? undefined : onClose}
      aria-labelledby={titleId}
      aria-describedby={textId}
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle id={titleId} sx={{ overflowWrap: 'anywhere' }}>
        {scheduleRowTexts.deleteTitle(task.name)}
      </DialogTitle>
      <DialogContent>
        <Typography id={textId} variant="body2" sx={{ color: 'text.secondary' }}>
          {scheduleRowTexts.deleteText}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={pending}>
          {scheduleRowTexts.cancel}
        </Button>
        <Button variant="contained" color="error" loading={pending} onClick={onConfirm}>
          {scheduleRowTexts.delete}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/**
 * «⋯» of a task (Зп5, Зп6): «Запустить сейчас», «Изменить» and «Удалить», or only some of them.
 * The button keeps the focus for what an item opens: the window of the task and the confirmation
 * come back to it — except after a deletion, when `onDeleted` says where the client goes on.
 */
export function ScheduleMoreMenu({
  task,
  actions,
  onEdit,
  items = ['run', 'edit', 'delete'],
  onDeleted,
  label,
  buttonRef,
}: {
  task: Task
  actions: ScheduleActions
  /** «Изменить»: the window opens, and comes back to `opener` when it closes. */
  onEdit?: (opener: HTMLElement | null) => void
  items?: readonly ('run' | 'edit' | 'delete')[]
  /** The task is deleted: the confirmation has closed. */
  onDeleted?: () => void
  /** The name of the button; the task's by default. */
  label?: string
  /** The button «⋯», for the focus of a list after a neighbour of it is deleted. */
  buttonRef?: Ref<HTMLButtonElement>
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [confirm, setConfirm] = useState(false)
  const close = () => setAnchor(null)
  return (
    <>
      <IconButton
        ref={buttonRef}
        aria-label={label ?? scheduleRowTexts.more(task.name)}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{
          width: 44,
          height: 44,
          borderRadius: '12px',
          color: 'text.secondary',
          '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
        }}
      >
        <AppIcon name="more" size={20} />
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { borderRadius: '14px', minWidth: 220 } } }}
      >
        {items.includes('run') ? (
          <MenuItem
            disabled={actions.runNow.isPending}
            onClick={() => {
              close()
              actions.start(task)
            }}
            sx={{ minHeight: 44, fontSize: 14 }}
          >
            <ListItemIcon>
              <AppIcon name="send" size={18} />
            </ListItemIcon>
            {scheduleRowTexts.runNow}
          </MenuItem>
        ) : null}
        {items.includes('edit') && onEdit ? (
          <MenuItem
            onClick={() => {
              // The button the menu hangs on: the window comes back to it.
              const opener = anchor
              close()
              onEdit(opener)
            }}
            sx={{ minHeight: 44, fontSize: 14 }}
          >
            <ListItemIcon>
              <AppIcon name="pencil" size={18} />
            </ListItemIcon>
            {scheduleRowTexts.edit}
          </MenuItem>
        ) : null}
        {items.includes('delete') ? (
          <MenuItem
            onClick={() => {
              close()
              setConfirm(true)
            }}
            sx={{ minHeight: 44, fontSize: 14, color: 'error.main' }}
          >
            <ListItemIcon sx={{ color: 'inherit' }}>
              <AppIcon name="trash" size={18} />
            </ListItemIcon>
            {scheduleRowTexts.delete}
          </MenuItem>
        ) : null}
      </Menu>
      <ScheduleDeleteDialog
        task={task}
        open={confirm}
        pending={actions.remove.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={() =>
          void actions.delete(task).then((deleted) => {
            setConfirm(false)
            if (deleted) onDeleted?.()
          })
        }
      />
    </>
  )
}

/** What an action said, for a moment at the bottom of the screen. */
export function ScheduleNoticeBar({
  notice,
  onClose,
}: {
  notice: ScheduleNotice
  onClose: () => void
}) {
  // The words stay while the bar slides away.
  const [last, setLast] = useState<ScheduleNotice>(notice)
  if (notice !== null && notice !== last) setLast(notice)
  return (
    <Snackbar
      open={notice !== null}
      onClose={(_, reason) => {
        if (reason !== 'clickaway') onClose()
      }}
      autoHideDuration={4000}
      message={(notice ?? last)?.text}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      action={
        <IconButton
          size="small"
          aria-label={scheduleRowTexts.close}
          onClick={onClose}
          sx={{ color: 'inherit' }}
        >
          <AppIcon name="close" size={16} />
        </IconButton>
      }
    />
  )
}
