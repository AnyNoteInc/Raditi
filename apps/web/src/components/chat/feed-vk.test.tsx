// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, type UseMutationOptions } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FeedVkAction, FeedVkProposal, VkPressed, vkCardText, vkPressedOf } from './feed-vk'

const RESERVED = '0199a000-0000-7000-8000-0000000000e1'

const publish = vi.hoisted(() => vi.fn<(input: Record<string, unknown>) => Promise<unknown>>())
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    builtinMcp: {
      vkPublish: {
        mutationOptions: (
          options: UseMutationOptions<unknown, Error, Record<string, unknown>>,
        ) => ({
          ...options,
          mutationFn: publish,
        }),
      },
    },
  }),
}))

const post = {
  kind: 'post' as const,
  reservedId: RESERVED,
  community: 'Кофейня у дома',
  text: 'Мы открылись!',
  publishAt: null,
}

function show(node: ReactNode, pressed: ReadonlySet<string> = new Set()) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <VkPressed.Provider value={pressed}>{node}</VkPressed.Provider>
    </QueryClientProvider>,
  )
}

beforeEach(() => publish.mockReset())

describe('the cards of VK', () => {
  it('publishes the text of the card, edited by the client', async () => {
    publish.mockResolvedValue({ actionId: '0199a000-0000-7000-8000-0000000000f1' })
    show(<FeedVkProposal row={post} />)
    expect(
      screen.getByText('Агент подготовил запись для группы «Кофейня у дома»'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: vkCardText.edit }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Мы открылись! Ждём вас.' } })
    fireEvent.click(screen.getByRole('button', { name: vkCardText.publish }))
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        { reservedId: RESERVED, text: 'Мы открылись! Ждём вас.' },
        expect.anything(),
      ),
    )
    expect(await screen.findByText(vkCardText.sent)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: vkCardText.publish })).toBeNull()
  })

  it('offers «Запланировать» for a delayed post', () => {
    show(<FeedVkProposal row={{ ...post, publishAt: '2026-11-28T06:00:00.000Z' }} />)
    expect(screen.getByRole('button', { name: vkCardText.schedule })).toBeInTheDocument()
  })

  it('shows no button on a card a press has reached already', () => {
    show(<FeedVkProposal row={post} />, new Set([RESERVED]))
    expect(screen.queryByRole('button', { name: vkCardText.publish })).toBeNull()
    expect(screen.getByText(vkCardText.sent)).toBeInTheDocument()
  })

  it('finds the pressed cards among the rows', () => {
    expect(
      vkPressedOf([
        { type: 'feed.vk_action', reservedId: RESERVED },
        { type: 'feed.vk_proposal', reservedId: 'other' },
      ]),
    ).toEqual(new Set([RESERVED]))
  })

  it('tells a published post with its link, and a refusal in the client’s words', () => {
    show(
      <>
        <FeedVkAction row={{ kind: 'post', state: 'done', url: 'https://vk.com/wall-1001_11' }} />
        <FeedVkAction row={{ kind: 'post', state: 'failed', error: 'VK_POST_REFUSED' }} />
      </>,
    )
    expect(screen.getByText('Запись опубликована во ВКонтакте.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: vkCardText.open })).toHaveAttribute(
      'href',
      'https://vk.com/wall-1001_11',
    )
    expect(screen.getByText(/^Не опубликовано: ВКонтакте не принял запись/)).toBeInTheDocument()
  })
})
