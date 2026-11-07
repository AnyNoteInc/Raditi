// The versions of PHP a preview tries, shared by the stacks (docs/plan/62-site-stacks.md, Т11,
// Т18): the one of the site's hosting first, then by distance from it. The list of a stack is its
// table — the order of WordPress, the branch of Joomla — and only versions of the images (Т19).

/** `8.3` → 803; null for anything that does not start with major.minor. */
export function phpVersionNumber(version: string): number | null {
  const match = /^(\d{1,2})\.(\d{1,2})(?:\.|$)/.exec(version)
  return match ? Number(match[1]) * 100 + Number(match[2]) : null
}

/**
 * The versions of `list` nearest to the site's first, the older of two equally near first: code
 * runs on an older minor more often than on a newer. Without a version of the site — or with one
 * that is not major.minor — the order of the list, which names the first choice first.
 */
export function phpVersionsNear(
  list: readonly string[],
  runtimeVersion: string | undefined,
): string[] {
  const wanted = phpVersionNumber(runtimeVersion ?? '')
  if (wanted === null) return [...list]
  const of = (version: string) => phpVersionNumber(version) ?? 0
  return [...list].sort(
    (a, b) => Math.abs(of(a) - wanted) - Math.abs(of(b) - wanted) || of(a) - of(b),
  )
}
