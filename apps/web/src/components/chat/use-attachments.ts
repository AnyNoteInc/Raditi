'use client'

import { attachmentLimits, attachmentTypeByName } from '@repo/domain/attachments/rules'
import { attachmentRefusalText } from '@repo/domain/attachments/labels'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'

import { useTRPCClient } from '@/trpc/client'

import {
  localRefusal,
  localRefusalText,
  uploadBytes,
  UploadFailure,
  type UploadBytes,
} from './attachment-upload'
import { callErrorText } from './call-error'

// The files of the message being written (docs/plan/57-browser-tasks.md, Б26): each is announced
// and its bytes sent as soon as it is chosen, one at a time; the message names the ones that are
// ready. A file not sent can be taken out again, a file that failed sent again.

export type AttachmentState = 'queued' | 'uploading' | 'ready' | 'failed'

/** One file of the message as its chip shows it. */
export interface AttachmentItem {
  /** Local to the page: a file has no id until the server announced it. */
  key: string
  name: string
  size: number
  kind: 'image' | 'document'
  state: AttachmentState
  /** 0..1 while uploading. */
  progress: number
  attachmentId: string | null
  /** Why it failed, as a sentence. */
  error: string | null
}

type Action =
  | { type: 'add'; items: AttachmentItem[] }
  | { type: 'patch'; key: string; patch: Partial<AttachmentItem> }
  | { type: 'remove'; key: string }
  | { type: 'clear' }

function reducer(items: AttachmentItem[], action: Action): AttachmentItem[] {
  switch (action.type) {
    case 'add':
      return [...items, ...action.items]
    case 'patch':
      return items.map((item) => (item.key === action.key ? { ...item, ...action.patch } : item))
    case 'remove':
      return items.filter((item) => item.key !== action.key)
    case 'clear':
      return []
  }
}

export interface AttachmentsControl {
  items: readonly AttachmentItem[]
  /** Files chosen in the dialog of the system: added and sent in turn. */
  add: (files: Iterable<File>) => void
  retry: (key: string) => void
  remove: (key: string) => void
  /** The message took the files: the chips go, the files stay with the task. */
  clear: () => void
  /** The ids of the files the message names, in the order chosen. */
  readyIds: readonly string[]
  /** A file is still on its way: the message waits for it. */
  uploading: boolean
  /** A file failed and is neither sent again nor taken out. */
  failed: boolean
  /** More files than a message takes were chosen: the sentence that says so. */
  notice: string | null
  dismissNotice: () => void
}

let counter = 0
const nextKey = () => `file-${++counter}`

/**
 * The files of one message for a site. `upload` sends the bytes (an XMLHttpRequest by default).
 */
export function useAttachments(
  siteId: string,
  upload: UploadBytes = uploadBytes,
): AttachmentsControl {
  const client = useTRPCClient()
  const [items, dispatch] = useReducer(reducer, [])
  const [notice, setNotice] = useReducer(
    (_previous: string | null, next: string | null) => next,
    null,
  )
  const files = useRef(new Map<string, File>())
  const controllers = useRef(new Map<string, AbortController>())
  // The server's id of each file, as soon as it is announced: what removing it must forget.
  const announced = useRef(new Map<string, string>())
  // The items as the last render drew them, for the handlers; the queue is kept apart and
  // synchronously, so a file is never taken twice while a render is pending.
  const itemsRef = useRef(items)
  const queue = useRef<string[]>([])
  const pumping = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  useEffect(() => {
    alive.current = true
    const running = controllers.current
    return () => {
      alive.current = false
      for (const controller of running.values()) controller.abort()
    }
  }, [])

  const forget = useCallback(
    (attachmentId: string | null) => {
      // A file nobody sent is removed on the server too; one that is not there is nothing to do.
      if (attachmentId !== null)
        void client.attachment.remove.mutate({ attachmentId }).catch(() => {})
    },
    [client],
  )

  const uploadOne = useCallback(
    async (key: string) => {
      const file = files.current.get(key)
      const type = file ? attachmentTypeByName(file.name) : null
      if (!file || type === null) return
      const controller = new AbortController()
      controllers.current.set(key, controller)
      const patch = (next: Partial<AttachmentItem>) => {
        if (alive.current && files.current.has(key)) dispatch({ type: 'patch', key, patch: next })
      }
      patch({ state: 'uploading', progress: 0, error: null, attachmentId: null })
      try {
        const started = await client.attachment.start.mutate({
          siteId,
          name: file.name,
          size: file.size,
          type: type.mime,
        })
        const attachmentId = started.attachmentId
        announced.current.set(key, attachmentId)
        // Taken out while it was announced: remove() could not know its id yet.
        if (controller.signal.aborted) {
          if (announced.current.delete(key)) forget(attachmentId)
          return
        }
        patch({ attachmentId })
        await upload(started.uploadPath, file, {
          signal: controller.signal,
          onProgress: (progress) => patch({ progress }),
        })
        patch({ state: 'ready', progress: 1 })
      } catch (error) {
        if (controller.signal.aborted) return
        patch({
          state: 'failed',
          error: error instanceof UploadFailure ? error.message : callErrorText(error),
        })
      } finally {
        controllers.current.delete(key)
      }
    },
    [client, forget, siteId, upload],
  )

  // One file at a time: the next queued one starts when the one before has ended. A file taken
  // out meanwhile is skipped.
  const pump = useCallback(async () => {
    if (pumping.current) return
    pumping.current = true
    try {
      for (let key = queue.current.shift(); key !== undefined; key = queue.current.shift()) {
        if (!alive.current) return
        if (files.current.has(key)) await uploadOne(key)
      }
    } finally {
      pumping.current = false
    }
  }, [uploadOne])

  const add = useCallback(
    (chosen: Iterable<File>) => {
      const room = attachmentLimits.perMessage - itemsRef.current.length
      const list = [...chosen]
      setNotice(list.length > room ? attachmentRefusalText.too_many : null)
      const added: AttachmentItem[] = []
      for (const file of list.slice(0, Math.max(0, room))) {
        const key = nextKey()
        const refusal = localRefusal(file)
        files.current.set(key, file)
        added.push({
          key,
          name: file.name,
          size: file.size,
          kind: attachmentTypeByName(file.name)?.kind ?? 'document',
          state: refusal === null ? 'queued' : 'failed',
          progress: 0,
          attachmentId: null,
          error: refusal === null ? null : localRefusalText(refusal),
        })
      }
      if (added.length === 0) return
      dispatch({ type: 'add', items: added })
      queue.current.push(...added.filter((item) => item.state === 'queued').map((item) => item.key))
      void pump()
    },
    [pump],
  )

  const retry = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((candidate) => candidate.key === key)
      const file = files.current.get(key)
      if (!item || !file || item.state !== 'failed' || localRefusal(file) !== null) return
      // The announcement of the failed try goes: a new one starts the file anew.
      forget(announced.current.get(key) ?? null)
      announced.current.delete(key)
      dispatch({ type: 'patch', key, patch: { state: 'queued', error: null, attachmentId: null } })
      queue.current.push(key)
      void pump()
    },
    [forget, pump],
  )

  const remove = useCallback(
    (key: string) => {
      controllers.current.get(key)?.abort()
      files.current.delete(key)
      dispatch({ type: 'remove', key })
      forget(announced.current.get(key) ?? null)
      announced.current.delete(key)
    },
    [forget],
  )

  const clear = useCallback(() => {
    files.current.clear()
    announced.current.clear()
    queue.current = []
    dispatch({ type: 'clear' })
    setNotice(null)
  }, [])

  return useMemo(
    () => ({
      items,
      add,
      retry,
      remove,
      clear,
      readyIds: items.flatMap((item) =>
        item.state === 'ready' && item.attachmentId !== null ? [item.attachmentId] : [],
      ),
      uploading: items.some((item) => item.state === 'queued' || item.state === 'uploading'),
      failed: items.some((item) => item.state === 'failed'),
      notice,
      dismissNotice: () => setNotice(null),
    }),
    [items, add, retry, remove, clear, notice],
  )
}
