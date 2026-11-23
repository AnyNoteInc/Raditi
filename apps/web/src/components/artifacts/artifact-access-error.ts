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

/**
 * The options of a private artifact read: a refusal replaces the cached data with null, and the
 * data leave the cache as soon as nothing reads them.
 */
export function privateArtifactQuery<TKey, TData, TContext>(options: {
  queryKey: TKey
  queryFn?: (context: TContext) => TData | Promise<TData>
}) {
  const read = options.queryFn
  if (!read) throw new Error('A private artifact read needs its query function')
  return {
    queryKey: options.queryKey,
    queryFn: (context: TContext) => readPrivateArtifact(() => read(context)),
    gcTime: 0,
  }
}
