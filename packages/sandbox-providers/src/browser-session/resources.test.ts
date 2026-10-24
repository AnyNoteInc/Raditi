import { describe, expect, it } from 'vitest'

import { browserBridge } from '../preview/resources.ts'
import {
  BROWSER_LABEL,
  browserSessionBridge,
  browserSessionFilter,
  browserSessionLabels,
  browserSessionNames,
  isSessionUuid,
  ownedBrowserResource,
} from './resources.ts'

const identity = {
  sessionId: '0196abcd-0000-7000-8000-0000000000a1',
  taskId: '0196abcd-0000-7000-8000-0000000000a2',
  siteId: '0196abcd-0000-7000-8000-0000000000a3',
}

describe('browser session resources', () => {
  it('labels every resource with the session, its task, site, deadline and role', () => {
    const labels = browserSessionLabels(identity, 'egress', 1_900_000_000_000)
    expect(labels).toEqual({
      'io.raditi.browser.owner': 'raditi',
      'io.raditi.browser.protocol': '1',
      'io.raditi.browser.session': identity.sessionId,
      'io.raditi.browser.task': identity.taskId,
      'io.raditi.browser.site': identity.siteId,
      'io.raditi.browser.deadline': '1900000000000',
      'io.raditi.browser.role': 'egress',
    })
    expect(ownedBrowserResource(labels)).toEqual({
      ...identity,
      role: 'egress',
      deadline: 1_900_000_000_000,
    })
    expect(browserSessionFilter(identity.sessionId, 'browser')).toEqual({
      label: [
        'io.raditi.browser.owner=raditi',
        'io.raditi.browser.protocol=1',
        `io.raditi.browser.session=${identity.sessionId}`,
        'io.raditi.browser.role=browser',
      ],
    })
  })

  it('owns nothing of another owner, protocol, role or with ids that are not ours', () => {
    const labels = browserSessionLabels(identity, 'browser', 1_900_000_000_000)
    const patches: Record<string, string>[] = [
      { [`${BROWSER_LABEL}owner`]: 'other' },
      { [`${BROWSER_LABEL}protocol`]: '2' },
      { [`${BROWSER_LABEL}role`]: 'web' },
      { [`${BROWSER_LABEL}session`]: identity.sessionId.toUpperCase() },
      { [`${BROWSER_LABEL}task`]: 'task-1' },
      { [`${BROWSER_LABEL}deadline`]: 'never' },
      { [`${BROWSER_LABEL}deadline`]: '0' },
    ]
    for (const patch of patches) expect(ownedBrowserResource({ ...labels, ...patch })).toBeNull()
    expect(ownedBrowserResource(undefined)).toBeNull()
    expect(isSessionUuid(identity.sessionId)).toBe(true)
    expect(isSessionUuid('../etc')).toBe(false)
  })

  it('names a bridge the host firewall knows, never that of a preview of the same id', () => {
    const bridge = browserSessionBridge(identity.sessionId)
    expect(bridge).toMatch(/^rpb[0-9a-f]{12}$/)
    expect(bridge).not.toBe(browserBridge(identity.sessionId))
    expect(browserSessionBridge(identity.taskId)).not.toBe(bridge)
    expect(browserSessionNames(identity.sessionId)).toMatchObject({
      network: `raditi-browser-${identity.sessionId}`,
    })
    expect(browserSessionNames(identity.sessionId).container('firewall', 'x')).toBe(
      `raditi-browser-${identity.sessionId}-firewall-x`,
    )
  })
})
