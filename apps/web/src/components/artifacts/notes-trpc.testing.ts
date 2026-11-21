import { vi } from 'vitest'

/**
 * The procedures of private notes (88.18а–е) for the mocks of `@/trpc/client` in the tests of the
 * bodies of artifacts: an owner sees the panel of notes, empty here. Only tests import it.
 */
export function notesTrpcMock(addComment: (input: unknown) => Promise<{ id: string }> = vi.fn()) {
  return {
    artifact: {
      comments: {
        queryOptions: (input: unknown) => ({
          queryKey: ['comments', input],
          queryFn: async () => [],
        }),
        queryKey: (input: unknown) => ['comments', input],
      },
      addComment: { mutationOptions: () => ({ mutationFn: addComment }) },
      resolveComment: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
    },
    client: { addCommentReply: { mutate: vi.fn() } },
  }
}
