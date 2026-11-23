// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CabinetArtifact } from '../use-artifact'
import { ArtifactImages, imagesTexts } from './artifact-images'

// «Изображение» in the cabinet (docs/plan/88-artifacts.md, §7.7, 88.26б): pictures in the sizes of
// their places, the chosen one in its size, its size changed with its revision, «Скачать PNG».

const ARTIFACT = '019f1a21-1800-7f00-8abc-0000000000a7'

const { write, frame, exportStart } = vi.hoisted(() => ({
  write: vi.fn(async (_input: unknown) => ({ seq: 2 })),
  frame: vi.fn(async (_input: unknown) => ({
    url: 'https://pages.test/v/token',
    expiresAt: '2026-11-22T11:00:00.000Z',
  })),
  exportStart: vi.fn(async (_input: unknown) => ({
    exportId: '019f1a21-1800-7f00-8abc-0000000000f7',
  })),
}))

vi.mock('@/trpc/client', async () => {
  const { notesTrpcMock } = await import('../notes-trpc.testing')
  const notes = notesTrpcMock(vi.fn())
  return {
    useTRPC: () => ({
      artifact: {
        ...notes.artifact,
        write: { mutationOptions: () => ({ mutationFn: write }) },
        exportStart: { mutationOptions: () => ({ mutationFn: exportStart }) },
        editText: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
        files: { queryOptions: () => ({ queryKey: ['artifact.files'], queryFn: async () => [] }) },
        fileStart: { mutationOptions: () => ({ mutationFn: vi.fn() }) },
        frame: {
          queryOptions: (input: unknown) => ({
            queryKey: ['frame', input],
            queryFn: () => frame(input),
          }),
        },
        canvasThumbs: {
          queryOptions: (input: unknown) => ({
            queryKey: ['thumbs', input],
            queryFn: async () => ({ thumbs: [], pending: false }),
          }),
        },
      },
    }),
    useTRPCClient: () => ({
      artifact: { ...notes.client, exportStatus: { query: async () => ({ state: 'ready' }) } },
    }),
  }
})

const block = (
  key: string,
  kind: string,
  parent: string | null,
  content: string | null,
  props: Record<string, string> = {},
  rev = 1,
) => ({
  key,
  kind,
  parent,
  rank: key,
  props,
  rev,
  heading: null,
  content,
  checking: false,
  hold: null,
})

function pictures(role: CabinetArtifact['role'] = 'owner'): CabinetArtifact {
  return {
    id: ARTIFACT,
    kind: 'image',
    title: 'Пост для соцсетей',
    seq: 3,
    role,
    version: 1,
    project: null,
    updatedAt: '2026-11-22T10:00:00.000Z',
    blocks: [
      block('a-style', 'style', null, '.picture{}'),
      block('post', 'frame', null, '', { name: 'Пост', size: 'post' }, 4),
      block('post-html', 'html', 'post', '<section>Пост</section>'),
      block('story', 'frame', null, '', { name: 'История', size: 'story' }, 2),
      block('story-html', 'html', 'story', '<section>История</section>'),
    ],
  } as CabinetArtifact
}

class Observer {
  observe() {}
  disconnect() {}
}

function show(artifact: CabinetArtifact) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ArtifactImages
        artifact={artifact}
        presence={null}
        onChanged={vi.fn()}
        onAccessLost={vi.fn()}
        place="page"
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', Observer)
  write.mockClear()
  exportStart.mockClear()
})

describe('«Изображение» in the cabinet', () => {
  it('lists the pictures with the sizes of their places and shows the chosen one', async () => {
    show(pictures())
    const strip = screen.getByRole('navigation', { name: imagesTexts.pictures })
    expect(
      within(strip)
        .getAllByRole('button')
        .map((each) => each.getAttribute('aria-label')),
    ).toEqual(['Пост, Пост', 'История, История'])
    await waitFor(() =>
      expect(frame).toHaveBeenCalledWith(expect.objectContaining({ frame: 'post' })),
    )
  })

  it('changes the size of a picture by its revision, keeping its other properties', async () => {
    show(pictures())
    fireEvent.mouseDown(screen.getByRole('combobox', { name: imagesTexts.size }))
    fireEvent.click(
      await screen.findByRole('option', { name: /Баннер и превью ссылки · 1200×630/ }),
    )
    await waitFor(() => expect(write).toHaveBeenCalled())
    expect(write.mock.calls[0]![0]).toMatchObject({
      batch: {
        ops: [{ op: 'props', block: 'post', props: { size: 'banner' } }],
      },
    })
  })

  it('asks core for the PNG of the chosen picture, and lets a reader only look and download', async () => {
    show(pictures('view'))
    fireEvent.click(screen.getByRole('button', { name: 'История, История' }))
    fireEvent.click(screen.getByRole('button', { name: imagesTexts.png }))
    await waitFor(() =>
      expect(exportStart).toHaveBeenCalledWith(
        { artifactId: ARTIFACT, format: 'png', frame: 'story' },
        expect.anything(),
      ),
    )
    expect(screen.queryByRole('button', { name: imagesTexts.add })).not.toBeInTheDocument()
  })
})
