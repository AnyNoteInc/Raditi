/**
 * A full page load instead of a client-side transition: the React Query cache, the router cache
 * and every other bit of client state of the previous account are gone. Used on sign-in and
 * sign-out.
 */
export function hardNavigate(path: string): void {
  window.location.assign(path)
}
