import {
  isSecretParameterName,
  type BrowserController,
  type BrowserTaskPolicy,
  type SiteBrowserRequest,
} from '@repo/domain'

/** Methods that only read: what a pass without its client may send to the site. */
const READS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/** What a session tells its policy of itself when a page of its browser sends a request. */
export interface ReadOnlyState {
  /** The agent's latest action came from a pass of a scheduled run without its client. */
  readOnly(): boolean
  /** The session sends the site's saved sign-in now (Б36). */
  signingIn(): boolean
  /** This rule denied a request — not the stack's policy: the session tells the agent why. */
  refused?(): void
}

/**
 * The stack's policy of a session, with what a pass of a scheduled run without its client may send
 * to the site on top of it (docs/plan/82-scheduled-tasks.md, Зп28: the browser only reads the
 * site). While the agent holds the browser in such a pass, a request of any page to the site is
 * denied before it leaves — whatever button, key, link, dialog or script of the page sent it — when
 * it does more than read:
 * - its method writes (a form, an XHR of an editor, an autosave, a method override): only the
 *   saved sign-in, which the session itself sends, goes (Б36);
 * - it reads but carries a secret in its query (`isSecretParameterName`: a nonce, a token, a key):
 *   such a link is an action of the admin — deactivate a plugin, trash a post, approve a comment,
 *   «Применить» of a list — and never a page the agent could have opened by its address, since the
 *   agent never sees the value (`redactTreeAddresses`). A list's search that carries one is opened
 *   by its address without it.
 * Before both, the stack's own word on its admin (`readOnlyDenied`): a GET that acts — WordPress's
 * `admin-ajax.php` with an `action` — is denied, a filter of a list sent with the nonce of its bulk
 * actions is allowed.
 * The client at the controls is not limited: they are there. Requests to another site are not the
 * stack's policy's to judge (page-rules) — there the instructions of the pass hold.
 */
export function readOnlyPolicy(policy: BrowserTaskPolicy, state: ReadOnlyState): BrowserTaskPolicy {
  return Object.freeze({
    ...policy,
    requestDenied: (request: SiteBrowserRequest, by?: BrowserController) => {
      if (policy.requestDenied(request, by)) return true
      if (by === 'user' || !state.readOnly() || !changesTheSite(policy, request, state))
        return false
      state.refused?.()
      return true
    },
  })
}

function changesTheSite(
  policy: BrowserTaskPolicy,
  request: SiteBrowserRequest,
  state: ReadOnlyState,
): boolean {
  // The stack knows its admin first: a read that acts, or a filter of a list with its nonce.
  const own = policy.readOnlyDenied?.(request) ?? null
  if (own !== null) return own
  if (!READS.has(request.method.trim().toUpperCase()))
    return !(state.signingIn() && (policy.signIn?.isSignInPage(request.path) ?? false))
  const query = request.path.split('#')[0]!.split('?').slice(1).join('?')
  for (const [name, value] of new URLSearchParams(query))
    if (value !== '' && isSecretParameterName(name)) return true
  return false
}
