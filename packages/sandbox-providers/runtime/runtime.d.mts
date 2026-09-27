// The pure checks of the sandbox helper that runtime.test.ts imports; the helper itself is run
// only inside the sandbox image.
export interface ProcessIdentity {
  state: string | undefined
  ppid: number
  group: number
  started: string | undefined
}

export function statIdentity(raw: string): ProcessIdentity
export function isProcessStart(value: unknown): value is string
export function isKeepaliveRecord(record: unknown): record is { pid: number; started: string }
