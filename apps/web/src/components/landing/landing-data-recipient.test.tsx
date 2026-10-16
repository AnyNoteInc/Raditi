// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Landing } from './landing'

vi.mock('@/app/(protected)/app/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/hard-navigate', () => ({ hardNavigate: vi.fn() }))

describe('landing: who processes a request', () => {
  it('names the one provider of the model and none of the earlier ones', () => {
    render(<Landing pricing={null} viewer={{ status: 'guest', user: null }} />)

    const answer = screen.getByText('Где будут храниться данные?').closest('details')
    expect(answer?.querySelector('p')).toHaveTextContent(
      'Для хранилищ платформы предусмотрено размещение в России. Задания обрабатывает модель GLM провайдера Z.ai за рубежом; переданные ему копии могут храниться по условиям этого провайдера. Условия обработки данных описаны в документах сервиса.',
    )
    // The page must not go on naming a recipient the platform no longer sends anything to.
    expect(document.body).not.toHaveTextContent(/OpenAI|Moonshot|ChatGPT|Codex|Kimi/i)
  })
})
