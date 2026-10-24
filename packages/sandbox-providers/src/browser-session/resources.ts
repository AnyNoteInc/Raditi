import { createHash } from 'node:crypto'

/**
 * Names, labels and addresses of a browser session's Docker resources
 * (docs/plan/57-browser-tasks.md, Б10, Б18). Everything a session owns carries
 * `io.raditi.browser.{owner,protocol,session,task,site,deadline,role}`; the host watchdog
 * (infra/sandbox/watchdog.mjs) reads the same labels and the same names and removes what is left
 * of a session past its deadline, when the worker is gone.
 */
export const BROWSER_LABEL = 'io.raditi.browser.'
export const BROWSER_OWNER = 'raditi'
export const BROWSER_PROTOCOL = '1'

export const browserSessionRoles = [
  'network',
  'egress',
  'forwarder',
  'browser',
  'firewall',
] as const
export type BrowserSessionRole = (typeof browserSessionRoles)[number]

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
/** Lower case, as the database writes them: they become names of containers. */
export const isSessionUuid = (value: unknown): value is string =>
  typeof value === 'string' && uuid.test(value)

export interface BrowserSessionIdentity {
  sessionId: string
  taskId: string
  siteId: string
}

/** The labels of one resource; `deadline` is epoch milliseconds. */
export function browserSessionLabels(
  identity: BrowserSessionIdentity,
  role: BrowserSessionRole,
  deadline: number,
): Record<string, string> {
  return {
    [`${BROWSER_LABEL}owner`]: BROWSER_OWNER,
    [`${BROWSER_LABEL}protocol`]: BROWSER_PROTOCOL,
    [`${BROWSER_LABEL}session`]: identity.sessionId,
    [`${BROWSER_LABEL}task`]: identity.taskId,
    [`${BROWSER_LABEL}site`]: identity.siteId,
    [`${BROWSER_LABEL}deadline`]: String(deadline),
    [`${BROWSER_LABEL}role`]: role,
  }
}

/** The Docker label filter of everything of one session, or of every session. */
export function browserSessionFilter(sessionId?: string, role?: BrowserSessionRole) {
  return {
    label: [
      `${BROWSER_LABEL}owner=${BROWSER_OWNER}`,
      `${BROWSER_LABEL}protocol=${BROWSER_PROTOCOL}`,
      ...(sessionId ? [`${BROWSER_LABEL}session=${sessionId}`] : []),
      ...(role ? [`${BROWSER_LABEL}role=${role}`] : []),
    ],
  }
}

export type OwnedBrowserResource = BrowserSessionIdentity & {
  role: BrowserSessionRole
  deadline: number
}

/** Ours: owner, protocol, ids, role and deadline as written; null for anything else. */
export function ownedBrowserResource(
  labels: Record<string, string> | undefined | null,
): OwnedBrowserResource | null {
  if (
    !labels ||
    labels[`${BROWSER_LABEL}owner`] !== BROWSER_OWNER ||
    labels[`${BROWSER_LABEL}protocol`] !== BROWSER_PROTOCOL
  )
    return null
  const sessionId = labels[`${BROWSER_LABEL}session`]
  const taskId = labels[`${BROWSER_LABEL}task`]
  const siteId = labels[`${BROWSER_LABEL}site`]
  const role = labels[`${BROWSER_LABEL}role`] as BrowserSessionRole
  const deadline = Number(labels[`${BROWSER_LABEL}deadline`])
  if (
    !isSessionUuid(sessionId) ||
    !isSessionUuid(taskId) ||
    !isSessionUuid(siteId) ||
    !browserSessionRoles.includes(role) ||
    !Number.isSafeInteger(deadline) ||
    deadline < 1
  )
    return null
  return { sessionId, taskId, siteId, role, deadline }
}

/**
 * The Linux bridge of a session (≤ 15 bytes). It shares the `rpb` prefix of a preview's browser
 * bridge — the one infra/sandbox/host-firewall.mjs keys its rules by under runsc — with a hash of
 * its own: 12 hex of SHA-256 of a tagged id never equal those of a preview's id.
 */
export const browserSessionBridge = (sessionId: string): string =>
  `rpb${createHash('sha256').update(`browser-session\0${sessionId}`).digest('hex').slice(0, 12)}`

export const browserSessionNames = (sessionId: string) => ({
  network: `raditi-browser-${sessionId}`,
  container: (role: BrowserSessionRole, suffix?: string) =>
    `raditi-browser-${sessionId}-${role}${suffix ? `-${suffix}` : ''}`,
})

/** Offsets of the fixed addresses on the session's network (subnetAddress). */
export const browserSessionAddresses = Object.freeze({ egress: 2, browser: 3, forwarder: 4 })
