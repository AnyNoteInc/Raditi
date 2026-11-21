type ErrorData = { code?: string | null; domainCode?: string | null }

export function artifactErrorData(error: unknown): ErrorData | undefined {
  return (error as { data?: ErrorData | null } | null)?.data ?? undefined
}

export function artifactAccessLost(error: unknown): boolean {
  const data = artifactErrorData(error)
  return data?.code === 'UNAUTHORIZED' || data?.domainCode === 'ARTIFACT_NOT_FOUND'
}

/** Replace private cached data on a refusal; a failed refetch alone would retain it. */
export async function readPrivateArtifact<T>(read: () => T | Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (artifactAccessLost(error)) return null
    throw error
  }
}
