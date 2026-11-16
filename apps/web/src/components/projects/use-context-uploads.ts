'use client'

import {
  projectFilePathRefusal,
  projectFileRefusalText,
  projectFileTypeByName,
  projectLimits,
  type ProjectFileRefusal,
} from '@repo/domain/projects'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'

import { uploadBytes, UploadFailure, type UploadBytes } from '@/components/chat/attachment-upload'
import { callErrorText } from '@/components/chat/call-error'
import { useTRPCClient } from '@/trpc/client'

// The files of the context being added (docs/plan/84-projects.md, ПР8; slice 84.10): each is
// announced (`projectFile.start`) and its bytes sent through web (`PUT /api/project-files/<id>`)
// as soon as it is chosen, one at a time, as the files of a message are. A file comes before its
// project: in the window of a new project the ready ids go with `project.create({ fileIds })`,
// which takes them in one transaction; on the page of a project each ready file is taken at once
// (`projectFile.bind`) and leaves this list for the project's own. A text the client wrote comes
// ready (`projectFile.addText`).

export type ContextUploadState = 'queued' | 'uploading' | 'ready' | 'failed'

/** One file of the context on its way, as its chip shows it. */
export interface ContextUpload {
  /** Local to the page: a file has no id until the server announced it. */
  key: string
  /** The path in the project: «Фото/витрина.jpg»; the server's clean one once announced. */
  name: string
  size: number
  kind: 'file' | 'text'
  state: ContextUploadState
  /** 0..1 while uploading. */
  progress: number
  fileId: string | null
  /** Why it failed, as a sentence. */
  error: string | null
}

/** A file chosen and the path it takes: a file of a folder keeps its folders. */
export interface ChosenFile {
  file: File
  path: string
}

type Action =
  | { type: 'add'; items: ContextUpload[] }
  | { type: 'patch'; key: string; patch: Partial<ContextUpload> }
  | { type: 'remove'; key: string }

function reducer(items: ContextUpload[], action: Action): ContextUpload[] {
  switch (action.type) {
    case 'add':
      return [...items, ...action.items]
    case 'patch':
      return items.map((item) => (item.key === action.key ? { ...item, ...action.patch } : item))
    case 'remove':
      return items.filter((item) => item.key !== action.key)
  }
}

const sentence = (text: string) => (/[.!?…]$/u.test(text) ? text : `${text}.`)

/**
 * Why a file would be refused before anything is sent: the rules of the domain the server checks
 * again. null — the file may be announced.
 */
export function contextRefusal(file: { path: string; size: number }): ProjectFileRefusal | null {
  if (file.size === 0) return 'empty'
  const path = projectFilePathRefusal(file.path)
  if (path !== null) return path
  if (projectFileTypeByName(file.path) === null) return 'type_not_allowed'
  if (file.size > projectLimits.fileBytes) return 'too_large'
  return null
}

export const contextRefusalText = (refusal: ProjectFileRefusal): string =>
  sentence(projectFileRefusalText[refusal])

/** The files of a choice of the system: a folder's keep the path the browser gave them. */
export function chosenFiles(list: Iterable<File>): ChosenFile[] {
  return [...list].map((file) => ({
    file,
    path:
      typeof file.webkitRelativePath === 'string' && file.webkitRelativePath !== ''
        ? file.webkitRelativePath
        : file.name,
  }))
}

interface EntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  fullPath: string
  file?: (done: (file: File) => void, failed: (error: unknown) => void) => void
  createReader?: () => {
    readEntries: (done: (entries: EntryLike[]) => void, failed: (error: unknown) => void) => void
  }
}

async function entryFiles(entry: EntryLike, depth: number): Promise<ChosenFile[]> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject))
    return [{ file, path: entry.fullPath.replace(/^\/+/u, '') }]
  }
  // Deeper than a path may be: the server would refuse every file of it; one refusal says so.
  if (!entry.isDirectory || !entry.createReader || depth > 16) return []
  const reader = entry.createReader()
  const entries: EntryLike[] = []
  // A reader gives its entries in pieces until an empty one.
  for (;;) {
    const piece = await new Promise<EntryLike[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    )
    if (piece.length === 0) break
    entries.push(...piece)
  }
  const nested = await Promise.all(entries.map((child) => entryFiles(child, depth + 1)))
  return nested.flat()
}

/** The files dropped on the field of the context: files, and folders with their paths. */
export async function droppedFiles(data: DataTransfer): Promise<ChosenFile[]> {
  const entries = [...data.items].flatMap((item) => {
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => EntryLike | null }
    ).webkitGetAsEntry?.()
    return entry ? [entry] : []
  })
  if (entries.length === 0) return chosenFiles(data.files)
  try {
    return (await Promise.all(entries.map((entry) => entryFiles(entry, 0)))).flat()
  } catch {
    return chosenFiles(data.files)
  }
}

export interface ContextUploads {
  items: readonly ContextUpload[]
  add: (files: readonly ChosenFile[]) => void
  /** «Добавить текстовое содержимое»: resolves when the server took the text, throws its words. */
  addText: (input: { title: string; text: string }) => Promise<void>
  retry: (key: string) => void
  remove: (key: string) => void
  /** The ids of the ready files of a project not created yet, in the order chosen. */
  readyIds: readonly string[]
  uploading: boolean
  /** The project took the files: nothing of them is removed when the window closes. */
  keepAll: () => void
  /** The window closes without a project: the files no project took go from the server too. */
  discardAll: () => void
}

let counter = 0
const nextKey = () => `context-${++counter}`

/**
 * The context being added: for `projectId` — each ready file goes to that project at once;
 * null — the window of a new project, which takes `readyIds` when it is created. `onBound` — a
 * file is the project's now (its lists are read again). `upload` sends the bytes.
 */
export function useContextUploads({
  projectId,
  onBound,
  upload = uploadBytes,
}: {
  projectId: string | null
  onBound?: () => void
  upload?: UploadBytes
}): ContextUploads {
  const client = useTRPCClient()
  const [items, dispatch] = useReducer(reducer, [])
  const files = useRef(new Map<string, ChosenFile>())
  const controllers = useRef(new Map<string, AbortController>())
  // The server's id of each file, as soon as it is announced: what removing it must forget.
  const announced = useRef(new Map<string, string>())
  const itemsRef = useRef(items)
  const queue = useRef<string[]>([])
  const pumping = useRef(false)
  const alive = useRef(true)
  const bound = useRef(onBound)

  useEffect(() => {
    itemsRef.current = items
    bound.current = onBound
  })

  useEffect(() => {
    alive.current = true
    const running = controllers.current
    return () => {
      alive.current = false
      for (const controller of running.values()) controller.abort()
    }
  }, [])

  const forget = useCallback(
    (fileId: string | null) => {
      // A file no project took is removed on the server too; one not there is nothing to do.
      if (fileId !== null)
        void client.projectFile.remove.mutate({ projectId: null, fileId }).catch(() => {})
    },
    [client],
  )

  const uploadOne = useCallback(
    async (key: string) => {
      const chosen = files.current.get(key)
      const type = chosen ? projectFileTypeByName(chosen.path) : null
      if (!chosen || type === null) return
      const controller = new AbortController()
      controllers.current.set(key, controller)
      const patch = (next: Partial<ContextUpload>) => {
        if (alive.current && files.current.has(key)) dispatch({ type: 'patch', key, patch: next })
      }
      patch({ state: 'uploading', progress: 0, error: null, fileId: null })
      try {
        const started = await client.projectFile.start.mutate({
          name: chosen.path,
          size: chosen.file.size,
          type: type.mime,
          ...(projectId === null ? {} : { projectId }),
        })
        announced.current.set(key, started.fileId)
        if (controller.signal.aborted) {
          if (announced.current.delete(key)) forget(started.fileId)
          return
        }
        patch({ fileId: started.fileId, name: started.name })
        await upload(started.uploadPath, chosen.file, {
          signal: controller.signal,
          onProgress: (progress) => patch({ progress }),
        })
        if (projectId === null) {
          patch({ state: 'ready', progress: 1 })
          return
        }
        await client.projectFile.bind.mutate({ projectId, fileIds: [started.fileId] })
        // The project's own list shows it now.
        announced.current.delete(key)
        files.current.delete(key)
        if (alive.current) dispatch({ type: 'remove', key })
        bound.current?.()
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
    [client, forget, upload, projectId],
  )

  // One file at a time: the next queued one starts when the one before has ended.
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
    (chosen: readonly ChosenFile[]) => {
      const added: ContextUpload[] = chosen.map((one) => {
        const key = nextKey()
        const refusal = contextRefusal({ path: one.path, size: one.file.size })
        files.current.set(key, one)
        return {
          key,
          name: one.path,
          size: one.file.size,
          kind: 'file',
          state: refusal === null ? 'queued' : 'failed',
          progress: 0,
          fileId: null,
          error: refusal === null ? null : contextRefusalText(refusal),
        }
      })
      if (added.length === 0) return
      dispatch({ type: 'add', items: added })
      queue.current.push(...added.filter((item) => item.state === 'queued').map((item) => item.key))
      void pump()
    },
    [pump],
  )

  const addText = useCallback(
    async ({ title, text }: { title: string; text: string }) => {
      const taken = await client.projectFile.addText.mutate({
        title,
        text,
        ...(projectId === null ? {} : { projectId }),
      })
      if (projectId !== null) {
        bound.current?.()
        return
      }
      const key = nextKey()
      dispatch({
        type: 'add',
        items: [
          {
            key,
            name: taken.name,
            size: new TextEncoder().encode(text).byteLength,
            kind: 'text',
            state: 'ready',
            progress: 1,
            fileId: taken.fileId,
            error: null,
          },
        ],
      })
      announced.current.set(key, taken.fileId)
    },
    [client, projectId],
  )

  const retry = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((candidate) => candidate.key === key)
      const chosen = files.current.get(key)
      if (!item || !chosen || item.state !== 'failed') return
      if (contextRefusal({ path: chosen.path, size: chosen.file.size }) !== null) return
      forget(announced.current.get(key) ?? null)
      announced.current.delete(key)
      dispatch({ type: 'patch', key, patch: { state: 'queued', error: null, fileId: null } })
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

  const keepAll = useCallback(() => {
    files.current.clear()
    announced.current.clear()
    queue.current = []
  }, [])

  const discardAll = useCallback(() => {
    for (const controller of controllers.current.values()) controller.abort()
    for (const fileId of announced.current.values()) forget(fileId)
    keepAll()
  }, [forget, keepAll])

  return useMemo(
    () => ({
      items,
      add,
      addText,
      retry,
      remove,
      readyIds: items.flatMap((item) =>
        item.state === 'ready' && item.fileId !== null ? [item.fileId] : [],
      ),
      uploading: items.some((item) => item.state === 'queued' || item.state === 'uploading'),
      keepAll,
      discardAll,
    }),
    [items, add, addText, retry, remove, keepAll, discardAll],
  )
}
