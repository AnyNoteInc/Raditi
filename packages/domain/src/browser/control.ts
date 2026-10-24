import type { BrowserController } from './session.ts'

/**
 * Who drives the browser of a task (docs/plan/57-browser-tasks.md, Б15–Б17): the agent or the
 * client, and through which tab of the cabinet. A pure machine — the worker keeps one per session,
 * feeds it every event in order and does what a step says; nothing here waits or does I/O.
 *
 * Every hand-over moves `controlEpoch` on, so input sent before it is refused. While the client
 * controls, the agent's queued actions are refused (`BROWSER_USER_IN_CONTROL`); the one already
 * running finishes within its own timeout, and only then is the client's input let through
 * (`manualReady`). A viewer that drops while it controls keeps the control (the pause holds until
 * it comes back or the session ends); only the keys and buttons it held are let go.
 */
export interface BrowserControl {
  controller: BrowserController
  controlEpoch: number
  /** The viewer (a tab of the cabinet, by its id) whose input is taken; null under the agent. */
  holder: string | null
  /** The client controls and no action of the agent is still running. */
  manualReady: boolean
  /** An action of the agent is running in the page. */
  agentActing: boolean
  /** The page the stream shows and input goes to; null before the first one. */
  pageId: number | null
  /** Moves on with every change of the window size: points of an older size are refused. */
  viewportVersion: number
}

/** What a step changed and what the worker must do now. */
export interface BrowserControlStep {
  control: BrowserControl
  /** Viewers need the new state. */
  changed: boolean
  /** Let go of every key and mouse button the client held down. */
  releaseInputs: boolean
}

export const initialBrowserControl = (): BrowserControl => ({
  controller: 'agent',
  controlEpoch: 0,
  holder: null,
  manualReady: false,
  agentActing: false,
  pageId: null,
  viewportVersion: 1,
})

const same = (control: BrowserControl): BrowserControlStep => ({
  control,
  changed: false,
  releaseInputs: false,
})
const step = (control: BrowserControl, releaseInputs: boolean): BrowserControlStep => ({
  control,
  changed: true,
  releaseInputs,
})

/**
 * «Взять управление» from `viewer`. From the agent: the epoch moves on and the agent's next
 * action is refused. From another viewer (Б15: one tab controls, another may take over
 * explicitly): the epoch moves on too, so input still on its way from the first one is refused.
 */
export function takeBrowserControl(control: BrowserControl, viewer: string): BrowserControlStep {
  if (control.controller === 'user' && control.holder === viewer) return same(control)
  return step(
    {
      ...control,
      controller: 'user',
      controlEpoch: control.controlEpoch + 1,
      holder: viewer,
      manualReady: !control.agentActing,
    },
    control.controller === 'user',
  )
}

/** «Продолжить работу агента» while a turn runs (the `release` message), from any viewer. */
export function releaseBrowserControl(control: BrowserControl): BrowserControlStep {
  if (control.controller === 'agent') return same(control)
  return step(
    {
      ...control,
      controller: 'agent',
      controlEpoch: control.controlEpoch + 1,
      holder: null,
      manualReady: false,
    },
    true,
  )
}

/** A turn starts (`ensure` with `takeControl`, Б16): the agent takes the browser back. */
export function agentTakesBrowserControl(control: BrowserControl): BrowserControlStep {
  return releaseBrowserControl(control)
}

/** A viewer's connection closed (Б17): the pause holds, held keys and buttons are let go. */
export function browserViewerLeft(control: BrowserControl, viewer: string): BrowserControlStep {
  if (control.controller !== 'user' || control.holder !== viewer) return same(control)
  return { control, changed: false, releaseInputs: true }
}

/** An action of the agent starts; the caller has admitted it (`admitBrowserAgentAction`). */
export function browserAgentActionStarted(control: BrowserControl): BrowserControlStep {
  if (control.agentActing) return same(control)
  return { control: { ...control, agentActing: true }, changed: false, releaseInputs: false }
}

/** The agent's action finished, failed or timed out: a waiting client may now act. */
export function browserAgentActionSettled(control: BrowserControl): BrowserControlStep {
  if (!control.agentActing) return same(control)
  const manualReady = control.controller === 'user'
  return {
    control: { ...control, agentActing: false, manualReady },
    changed: manualReady !== control.manualReady,
    releaseInputs: false,
  }
}

/** The stream shows another page (a tab was selected, opened or closed). */
export function browserPageShown(control: BrowserControl, pageId: number): BrowserControlStep {
  if (control.pageId === pageId) return same(control)
  return step({ ...control, pageId }, control.controller === 'user')
}

/** The window got another size: points measured on the old one are refused. */
export function browserViewportResized(control: BrowserControl): BrowserControlStep {
  return step(
    { ...control, viewportVersion: control.viewportVersion + 1 },
    control.controller === 'user',
  )
}

/** Why the worker refused input or a command of a viewer (the `refused` message). */
export const browserInputRefusals = [
  /** The agent controls the browser. */
  'agent_in_control',
  /** Another tab of the cabinet controls it. */
  'not_holder',
  /** The agent's last action has not settled yet. */
  'not_ready',
  /** Sent before the last hand-over. */
  'stale_epoch',
  /** Aimed at a page the stream no longer shows. */
  'stale_page',
  /** Measured on a window of another size. */
  'stale_viewport',
] as const
export type BrowserInputRefusal = (typeof browserInputRefusals)[number]

export type BrowserControlVerdict = { ok: true } | { ok: false; reason: BrowserInputRefusal }

/** What a viewer's input carries to be checked against the control. */
export interface BrowserInputStamp {
  viewer: string
  pageId: number
  controlEpoch: number
  viewportVersion: number
}

const refused = (reason: BrowserInputRefusal): BrowserControlVerdict => ({ ok: false, reason })
const OK: BrowserControlVerdict = Object.freeze({ ok: true })

/**
 * A command of a viewer that needs the control but no point on the page: navigate, select a tab,
 * answer a dialog, give files to a chooser, change the window size.
 */
export function admitBrowserUserCommand(
  control: BrowserControl,
  viewer: string,
): BrowserControlVerdict {
  if (control.controller !== 'user') return refused('agent_in_control')
  if (control.holder !== viewer) return refused('not_holder')
  if (!control.manualReady) return refused('not_ready')
  return OK
}

/** Mouse, wheel, keys and text of a viewer, aimed at the page and the window it saw. */
export function admitBrowserInput(
  control: BrowserControl,
  input: BrowserInputStamp,
): BrowserControlVerdict {
  const command = admitBrowserUserCommand(control, input.viewer)
  if (!command.ok) return command
  if (input.controlEpoch !== control.controlEpoch) return refused('stale_epoch')
  if (input.pageId !== control.pageId) return refused('stale_page')
  if (input.viewportVersion !== control.viewportVersion) return refused('stale_viewport')
  return OK
}

/** Whether the agent may act now; an action already queued is checked again when it starts. */
export function admitBrowserAgentAction(control: BrowserControl): 'ok' | 'BROWSER_USER_IN_CONTROL' {
  return control.controller === 'agent' ? 'ok' : 'BROWSER_USER_IN_CONTROL'
}
