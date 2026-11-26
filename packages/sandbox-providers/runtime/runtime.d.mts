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
/** Frame types of follow-exec (docs/plan/95). */
export const FOLLOW_FRAME: Readonly<{ stdout: 1; stderr: 2; end: 3; again: 4 }>
/** One frame of follow-exec: type, offset and length (u32, big-endian), then the bytes. */
export function followFrame(type: number, offset: number, data: Uint8Array): Buffer
