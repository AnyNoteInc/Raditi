// The document of the agent the tests of its card and of its view read (docs/plan/74).

export const docId = '0199a3f2-0000-7000-8000-0000000000d1'

export const sampleDoc = (
  version: number,
  { draft = version === 0, view = 'text' as 'page' | 'text', canPublish = false } = {},
) => ({
  docId,
  title: 'Аудит скорости сайта',
  view,
  version,
  revision: 4,
  progress: { written: draft ? 2 : 3, total: 3 },
  draft,
  sections: draft
    ? [
        {
          key: 'summary',
          intent: 'Итог',
          state: 'shown',
          heading: 'Итог',
          markdown: 'Три **главные** причины.',
        },
        { key: 'method', intent: 'Как мерили', state: 'unchecked', heading: null, markdown: null },
        { key: 'sources', intent: 'Источники', state: 'pending', heading: null, markdown: null },
      ]
    : [
        {
          key: 'summary',
          intent: 'Итог',
          state: 'shown',
          heading: 'Итог',
          markdown: 'Три **главные** причины.',
        },
        {
          key: 'method',
          intent: 'Как мерили',
          state: 'shown',
          heading: 'Как мерили',
          markdown: 'Пять замеров.',
        },
        {
          key: 'sources',
          intent: 'Источники',
          state: 'shown',
          heading: 'Источники',
          markdown: 'PageSpeed.',
        },
      ],
  page: null,
  canPublish,
})

type Call = (input: { docId: string }) => unknown

export const trpcMock = (fns: { readDoc: Call; readPage?: Call; publishDoc?: Call }) => ({
  useTRPC: () => ({
    pages: {
      doc: {
        queryKey: (input: { docId: string }) => ['pages', 'doc', input.docId],
        queryOptions: (input: { docId: string }) => ({
          queryKey: ['pages', 'doc', input.docId],
          queryFn: () => fns.readDoc(input),
        }),
      },
      docPage: {
        queryOptions: (input: { docId: string; version?: number }) => ({
          queryKey: ['pages', 'docPage', input.docId, input.version],
          queryFn: () => fns.readPage?.(input) ?? null,
        }),
      },
      publishDoc: {
        mutationOptions: () => ({
          mutationFn: (input: { docId: string }) => fns.publishDoc?.(input),
        }),
      },
      list: { queryKey: () => ['pages', 'list'] },
    },
  }),
})
