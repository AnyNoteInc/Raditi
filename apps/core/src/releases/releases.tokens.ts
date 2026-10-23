/**
 * The provider of site repositories acting as the release account — the owner of the
 * organization `sites`, whose token Vault keeps (plan 53, Р26, Р35; R8a): tags, their protection
 * and the secrets of a repository. null while git is not configured.
 */
export const RELEASE_GIT_PROVIDER = Symbol('RELEASE_GIT_PROVIDER')
