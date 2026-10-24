import { describe, expect, it } from 'vitest'

import {
  admitBrowserAgentAction,
  admitBrowserInput,
  admitBrowserUserCommand,
  agentTakesBrowserControl,
  browserAgentActionSettled,
  browserAgentActionStarted,
  browserPageShown,
  browserViewerLeft,
  browserViewportResized,
  initialBrowserControl,
  releaseBrowserControl,
  takeBrowserControl,
  type BrowserControl,
  type BrowserControlStep,
} from './control.ts'

const tabA = '0196abcd-0000-7000-8000-00000000000a'
const tabB = '0196abcd-0000-7000-8000-00000000000b'

/** The machine as the worker runs it: every step on the last state. */
function run(start: BrowserControl, ...steps: ((control: BrowserControl) => BrowserControlStep)[]) {
  let control = start
  const seen: BrowserControlStep[] = []
  for (const next of steps) {
    const step = next(control)
    seen.push(step)
    control = step.control
  }
  return { control, steps: seen }
}

const onPage = (control: BrowserControl) => browserPageShown(control, 1).control
const stampOf = (control: BrowserControl, viewer = tabA) => ({
  viewer,
  pageId: control.pageId ?? 0,
  controlEpoch: control.controlEpoch,
  viewportVersion: control.viewportVersion,
})

describe('control of the browser', () => {
  it('starts with the agent and no page', () => {
    const control = initialBrowserControl()
    expect(control).toEqual({
      controller: 'agent',
      controlEpoch: 0,
      holder: null,
      manualReady: false,
      agentActing: false,
      pageId: null,
      viewportVersion: 1,
    })
    expect(admitBrowserAgentAction(control)).toBe('ok')
    expect(admitBrowserUserCommand(control, tabA)).toEqual({
      ok: false,
      reason: 'agent_in_control',
    })
  })

  it('hands the browser to a viewer at once when the agent is idle', () => {
    const start = onPage(initialBrowserControl())
    const step = takeBrowserControl(start, tabA)
    expect(step).toEqual({
      control: { ...start, controller: 'user', controlEpoch: 1, holder: tabA, manualReady: true },
      changed: true,
      releaseInputs: false,
    })
    expect(admitBrowserAgentAction(step.control)).toBe('BROWSER_USER_IN_CONTROL')
    expect(admitBrowserInput(step.control, stampOf(step.control))).toEqual({ ok: true })
    // Taking again from the same tab changes nothing.
    expect(takeBrowserControl(step.control, tabA)).toEqual({
      control: step.control,
      changed: false,
      releaseInputs: false,
    })
  })

  it('lets the client in only after the running action of the agent settles', () => {
    const { control, steps } = run(
      onPage(initialBrowserControl()),
      browserAgentActionStarted,
      (control) => takeBrowserControl(control, tabA),
    )
    expect(control).toMatchObject({ controller: 'user', manualReady: false, agentActing: true })
    // The next queued action of the agent is refused; the client waits.
    expect(admitBrowserAgentAction(control)).toBe('BROWSER_USER_IN_CONTROL')
    expect(admitBrowserInput(control, stampOf(control))).toEqual({ ok: false, reason: 'not_ready' })
    expect(steps[0]?.changed).toBe(false)
    const settled = browserAgentActionSettled(control)
    expect(settled).toEqual({
      control: { ...control, agentActing: false, manualReady: true },
      changed: true,
      releaseInputs: false,
    })
    expect(admitBrowserInput(settled.control, stampOf(settled.control))).toEqual({ ok: true })
    // Settling twice is nothing.
    expect(browserAgentActionSettled(settled.control).changed).toBe(false)
  })

  it('settling an action under the agent tells no viewer anything', () => {
    const acting = browserAgentActionStarted(onPage(initialBrowserControl())).control
    expect(browserAgentActionStarted(acting).control).toBe(acting)
    const step = browserAgentActionSettled(acting)
    expect(step.control).toMatchObject({ agentActing: false, manualReady: false })
    expect(step.changed).toBe(false)
  })

  it('gives the browser back to the agent with a new epoch', () => {
    const user = takeBrowserControl(onPage(initialBrowserControl()), tabA).control
    const step = releaseBrowserControl(user)
    expect(step).toEqual({
      control: { ...user, controller: 'agent', controlEpoch: 2, holder: null, manualReady: false },
      changed: true,
      releaseInputs: true,
    })
    expect(admitBrowserAgentAction(step.control)).toBe('ok')
    // Input stamped before the release is refused.
    expect(admitBrowserInput(step.control, stampOf(user))).toEqual({
      ok: false,
      reason: 'agent_in_control',
    })
    expect(releaseBrowserControl(step.control).changed).toBe(false)
  })

  it('takes the browser back for the agent when a turn starts', () => {
    const user = takeBrowserControl(onPage(initialBrowserControl()), tabA).control
    expect(agentTakesBrowserControl(user).control).toMatchObject({
      controller: 'agent',
      controlEpoch: 2,
      holder: null,
    })
    const agent = initialBrowserControl()
    expect(agentTakesBrowserControl(agent)).toEqual({
      control: agent,
      changed: false,
      releaseInputs: false,
    })
  })

  it('lets another tab take over explicitly, refusing the first one from then on', () => {
    const first = takeBrowserControl(onPage(initialBrowserControl()), tabA).control
    const step = takeBrowserControl(first, tabB)
    expect(step.control).toMatchObject({ holder: tabB, controlEpoch: 2, manualReady: true })
    expect(step.releaseInputs).toBe(true)
    expect(admitBrowserInput(step.control, stampOf(first, tabA))).toEqual({
      ok: false,
      reason: 'not_holder',
    })
    expect(admitBrowserUserCommand(step.control, tabA)).toEqual({ ok: false, reason: 'not_holder' })
    expect(admitBrowserInput(step.control, stampOf(step.control, tabB))).toEqual({ ok: true })
  })

  it('keeps the pause when the controlling tab drops, and lets its keys go', () => {
    const user = takeBrowserControl(onPage(initialBrowserControl()), tabA).control
    const left = browserViewerLeft(user, tabA)
    expect(left).toEqual({ control: user, changed: false, releaseInputs: true })
    expect(admitBrowserAgentAction(left.control)).toBe('BROWSER_USER_IN_CONTROL')
    // The same tab, back, goes on with the same epoch.
    expect(admitBrowserInput(left.control, stampOf(user))).toEqual({ ok: true })
    // Another tab leaving, or any tab under the agent, changes nothing.
    expect(browserViewerLeft(user, tabB)).toEqual({
      control: user,
      changed: false,
      releaseInputs: false,
    })
    expect(browserViewerLeft(initialBrowserControl(), tabA).releaseInputs).toBe(false)
  })

  it('refuses input aimed at an old epoch, another page or another window size', () => {
    const user = takeBrowserControl(onPage(initialBrowserControl()), tabA).control
    const stamp = stampOf(user)
    expect(admitBrowserInput(user, { ...stamp, controlEpoch: 0 })).toEqual({
      ok: false,
      reason: 'stale_epoch',
    })
    expect(admitBrowserInput(user, { ...stamp, pageId: 2 })).toEqual({
      ok: false,
      reason: 'stale_page',
    })
    expect(admitBrowserInput(user, { ...stamp, viewportVersion: 2 })).toEqual({
      ok: false,
      reason: 'stale_viewport',
    })

    const resized = browserViewportResized(user)
    expect(resized.control.viewportVersion).toBe(2)
    expect(resized.releaseInputs).toBe(true)
    expect(admitBrowserInput(resized.control, stamp)).toEqual({
      ok: false,
      reason: 'stale_viewport',
    })

    const other = browserPageShown(user, 2)
    expect(other.control.pageId).toBe(2)
    expect(other.releaseInputs).toBe(true)
    expect(admitBrowserInput(other.control, stamp)).toEqual({ ok: false, reason: 'stale_page' })
    expect(browserPageShown(other.control, 2).changed).toBe(false)
    // Under the agent a new page or size lets nothing go: the client held nothing.
    expect(browserPageShown(initialBrowserControl(), 1).releaseInputs).toBe(false)
    expect(browserViewportResized(initialBrowserControl()).releaseInputs).toBe(false)
  })

  it('never lets two hand-overs share an epoch', () => {
    const { steps } = run(
      onPage(initialBrowserControl()),
      (control) => takeBrowserControl(control, tabA),
      (control) => takeBrowserControl(control, tabB),
      releaseBrowserControl,
      (control) => takeBrowserControl(control, tabA),
      agentTakesBrowserControl,
    )
    expect(steps.map((step) => step.control.controlEpoch)).toEqual([1, 2, 3, 4, 5])
  })
})
