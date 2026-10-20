// A process a *.test.ts file can kill -9 or pause: its dependencies go through wrap(), and once
// frozen every call through them — and through anything they returned — waits, as if the
// process were gone. thaw() lets a paused process go on: a zombie with a stale fence.

const passThrough = (value: unknown) =>
  typeof value !== 'object' ||
  value === null ||
  Array.isArray(value) ||
  ArrayBuffer.isView(value) ||
  value instanceof Date

export function crashable() {
  let gate: Promise<void> | undefined
  let open: () => void = () => {}
  const wrap = <T>(value: T): T => {
    if (value instanceof Promise) return value.then(wrap) as T
    if (passThrough(value)) return value
    return new Proxy(value as object, {
      get(target, key) {
        // The target's own getters and private fields, never through the proxy.
        const member: unknown = Reflect.get(target, key)
        if (typeof member !== 'function') return member
        return (...args: unknown[]) => {
          if (gate) return gate.then(() => wrap(member.apply(target, args)))
          return wrap(member.apply(target, args))
        }
      },
    }) as T
  }
  return {
    wrap,
    /** From now on every call waits: kill -9 when never thawed. */
    freeze(): void {
      gate ??= new Promise<void>((resolve) => {
        open = resolve
      })
    },
    thaw(): void {
      open()
      gate = undefined
    },
  }
}
