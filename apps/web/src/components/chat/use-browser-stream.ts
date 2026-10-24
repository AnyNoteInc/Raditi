'use client'

import type {
  BrowserClientMessage,
  BrowserStreamEndReason,
  BrowserStreamRefusal,
} from '@repo/domain/browser/stream-messages'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useTRPCClient } from '@/trpc/client'

import type { FramePainter } from './browser-canvas'
import {
  BrowserStreamClient,
  type BrowserState,
  type StreamConnection,
  type StreamSocket,
} from './browser-stream'
import { isNotFound } from './call-error'

// The stream of a task's browser for the window of the task (docs/plan/57-browser-tasks.md, Б12,
// Б14): open only while the page and the panel are shown — or while a press of «Взять
// управление» or «Продолжить работу агента» waits to be sent —, never on the server. Every
// connection takes a fresh one-time ticket: a mutation used as a query, kept nowhere (like the
// frame of a preview).

/**
 * Which moment of the browser a refusal speaks of: another holder, epoch of control, page or
 * address makes it history.
 */
const momentOf = (state: BrowserState | null): string | null =>
  state === null
    ? null
    : `${state.controlEpoch}\n${state.holder ?? ''}\n${state.pageId ?? ''}\n${state.url}`

export interface BrowserStream {
  connection: StreamConnection
  /** Why the stream ended (`closed { reason }`); null while it did not. */
  endReason: BrowserStreamEndReason | null
  state: BrowserState | null
  /** The id the gateway gave this tab's connection. */
  viewer: string | null
  /** This tab drives the browser. */
  holding: boolean
  /**
   * The latest refusal of the browser while it still applies — the same holder, epoch, page and
   * address —, with a counter so the same one is told again.
   */
  refusal: { reason: BrowserStreamRefusal; seq: number } | null
  /** Sends a message while the stream is open; false — it is not. */
  send: (message: BrowserClientMessage) => boolean
  take: () => void
  release: () => void
  retry: () => void
  /** The canvas that draws the frames; null while there is none. */
  setPainter: (painter: FramePainter | null) => void
}

export function useBrowserStream({
  taskId,
  streamUrl,
  live,
  visible,
  createSocket,
}: {
  taskId: string
  /** `BROWSER_STREAM_PUBLIC_URL` of the cabinet; null — the platform has no browser here. */
  streamUrl: string | null
  /** The task has an open session (`starting` or `ready`). */
  live: boolean
  /** The panel is on the screen. */
  visible: boolean
  createSocket?: (url: string) => StreamSocket
}): BrowserStream {
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const [connection, setConnection] = useState<StreamConnection>('idle')
  const [endReason, setEndReason] = useState<BrowserStreamEndReason | null>(null)
  const [state, setState] = useState<BrowserState | null>(null)
  const [viewer, setViewer] = useState<string | null>(null)
  // A refusal with the moment of the browser it came under; `seq` only grows (a press waits on it).
  const [told, setTold] = useState<{
    reason: BrowserStreamRefusal
    seq: number
    moment: string | null
  } | null>(null)
  const moment = useRef<string | null>(null)
  // A press that needs the stream while the panel is hidden opens it for that press, until the
  // state shows it done or the browser refuses it.
  const [pending, setPending] = useState<{ kind: 'take' | 'release'; refusals: number } | null>(
    null,
  )
  const pendingKind = useRef<'take' | 'release' | null>(null)
  const painter = useRef<FramePainter | null>(null)
  const stream = useRef<BrowserStreamClient | null>(null)
  const round = useRef(0)
  // The viewer this tab held the control under, carried from a closed stream to the next one: a
  // panel hidden and shown again, or a page hidden and shown again, keeps the control (Б17).
  const heldBy = useRef<string | null>(null)
  useEffect(() => {
    heldBy.current = null
  }, [taskId])

  // A hidden page watches nothing: its stream closes, so an unwatched session can go idle (Б18).
  const [pageShown, setPageShown] = useState(true)
  useEffect(() => {
    const changed = () => setPageShown(document.visibilityState !== 'hidden')
    changed()
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])

  const pressDone =
    pending !== null &&
    state !== null &&
    (pending.kind === 'take'
      ? state.controller === 'user' && viewer !== null && state.holder === viewer
      : state.controller === 'agent')
  // A press shown done is forgotten at once (state from the previous render, as React allows):
  // the stream it opened closes with it and does not open again when the state goes. Nor does a
  // press outlive a hidden page: its stream closed with the page, the client presses again.
  if (pressDone || (pending !== null && !pageShown)) setPending(null)
  const pressWaits =
    pending !== null && !pressDone && pageShown && (told?.seq ?? 0) === pending.refusals
  const enabled = streamUrl !== null && live && pageShown && (visible || pressWaits)

  useEffect(() => {
    if (!enabled || streamUrl === null) return
    const instance = new BrowserStreamClient({
      streamUrl,
      ticket: () =>
        queryClient.fetchQuery({
          queryKey: ['chat', 'browser-ticket', taskId, (round.current += 1)],
          queryFn: () => client.browser.streamTicket.mutate({ taskId }),
          staleTime: 0,
          gcTime: 0,
          retry: false,
        }),
      isGone: isNotFound,
      draw: (frame) => painter.current?.paint(frame) ?? Promise.resolve(false),
      createSocket,
      heldBy: heldBy.current,
      events: {
        connection: (next, reason) => {
          setConnection(next)
          setEndReason(reason)
        },
        state: (next) => {
          moment.current = momentOf(next)
          setState(next)
        },
        viewer: setViewer,
        refused: (reason) =>
          setTold((previous) => ({
            reason,
            seq: (previous?.seq ?? 0) + 1,
            moment: moment.current,
          })),
      },
    })
    stream.current = instance
    // A press made while no stream was open goes with the first state of this one.
    if (pendingKind.current === 'take') instance.take()
    else if (pendingKind.current === 'release') instance.release()
    pendingKind.current = null
    instance.start()
    return () => {
      instance.stop()
      // `stop()` keeps the viewer that held the control: the next stream takes it back.
      heldBy.current = instance.heldBy
      moment.current = null
      if (stream.current === instance) stream.current = null
      // What a closed stream said is not the state of the browser any more.
      setConnection('idle')
      setViewer(null)
      setState(null)
    }
  }, [enabled, streamUrl, taskId, client, queryClient, createSocket])

  const send = useCallback(
    (message: BrowserClientMessage) => stream.current?.send(message) ?? false,
    [],
  )
  const press = useCallback(
    (kind: 'take' | 'release') => {
      setPending({ kind, refusals: told?.seq ?? 0 })
      if (stream.current === null) pendingKind.current = kind
      else if (kind === 'take') stream.current.take()
      else stream.current.release()
    },
    [told],
  )
  const take = useCallback(() => press('take'), [press])
  const release = useCallback(() => press('release'), [press])
  const retry = useCallback(() => stream.current?.retry(), [])
  const setPainter = useCallback((next: FramePainter | null) => {
    painter.current = next
  }, [])

  const holding =
    connection === 'open' &&
    state !== null &&
    viewer !== null &&
    state.controller === 'user' &&
    state.holder === viewer
  // A refusal is said while the browser stands where it came: not once another tab took over, the
  // epoch moved, the page or its address changed, or the stream closed.
  const refusal =
    told !== null && state !== null && told.moment === momentOf(state)
      ? { reason: told.reason, seq: told.seq }
      : null

  return {
    connection,
    endReason,
    state,
    viewer,
    holding,
    refusal,
    send,
    take,
    release,
    retry,
    setPainter,
  }
}
