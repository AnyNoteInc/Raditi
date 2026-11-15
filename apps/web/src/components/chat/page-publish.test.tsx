// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { PublishTargetDialog, publishablePages, type PublishablePage } from './page-publish'

// Where a file of the chat goes (docs/plan/73-pages-sites.md, Дер9): a new page or the next
// version of a live page of the chat's workspace (the server's `pages.targets`), whatever chat
// made it; the page of the same file first.

const page = (overrides: Partial<PublishablePage> = {}): PublishablePage => ({
  pageId: '019f1a21-1800-7f00-8abc-000000000001',
  title: 'Прайс',
  version: 3,
  sourceFileName: 'другой.html',
  ...overrides,
})

function show(overrides: Partial<ComponentProps<typeof PublishTargetDialog>> = {}) {
  const onPublish = vi.fn()
  const props: ComponentProps<typeof PublishTargetDialog> = {
    open: true,
    fileName: 'Прайс.html',
    defaultTitle: 'Прайс',
    pages: [page()],
    loading: false,
    failed: false,
    pending: false,
    onPublish,
    onClose: () => undefined,
    ...overrides,
  }
  const view = render(<PublishTargetDialog {...props} />)
  return {
    onPublish,
    rerender: (next: Partial<typeof props>) =>
      view.rerender(<PublishTargetDialog {...props} {...next} />),
  }
}

describe('publishablePages', () => {
  it('puts the page of the same file first', () => {
    const pages = [page({ pageId: 'a' }), page({ pageId: 'b', sourceFileName: 'Прайс.html' })]
    expect(publishablePages(pages, 'Прайс.html').map((each) => each.pageId)).toEqual(['b', 'a'])
  })
})

describe('«Опубликовать как страницу»: where it goes', () => {
  it('publishes a new page by default, with the title the client wrote', () => {
    const { onPublish } = show()
    const dialog = screen.getByRole('dialog', { name: 'Опубликовать «Прайс.html»' })
    expect(within(dialog).getByRole('radio', { name: 'Новой страницей' })).toHaveProperty(
      'checked',
      true,
    )
    fireEvent.change(within(dialog).getByLabelText('Название страницы'), {
      target: { value: 'Прайс — декабрь' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Опубликовать' }))
    expect(onPublish).toHaveBeenCalledWith({ new: { title: 'Прайс — декабрь' } })
  })

  it('offers the page of the same file as a version first, at the version shown', () => {
    const { onPublish } = show({
      pages: [
        page(),
        page({ pageId: 'same', title: 'Старый прайс', version: 2, sourceFileName: 'Прайс.html' }),
      ],
    })
    expect(screen.getByRole('radio', { name: 'Новой страницей' })).toHaveProperty('checked', false)
    expect(screen.getByRole('combobox', { name: 'Страница' }).textContent).toContain(
      'из этого же файла',
    )
    expect(screen.getByText(/название страницы останется/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Опубликовать' }))
    expect(onPublish).toHaveBeenCalledWith({ pageId: 'same', expectedVersion: 2 })
  })

  it('opens at once while the pages load, and takes the default of pages that come late', () => {
    const { rerender } = show({ pages: null, loading: true })
    expect(screen.getByText('Загружаем страницы…')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Новой версией страницы' })).toHaveProperty(
      'disabled',
      true,
    )
    rerender({
      pages: [page({ pageId: 'same', sourceFileName: 'Прайс.html' })],
      loading: false,
    })
    expect(screen.getByRole('radio', { name: 'Новой версией страницы' })).toHaveProperty(
      'checked',
      true,
    )
  })

  it('offers a new page alone when the pages could not be loaded, and says so', () => {
    const { onPublish } = show({ pages: null, failed: true })
    expect(screen.getByRole('alert').textContent).toContain('Не удалось загрузить страницы')
    fireEvent.click(screen.getByRole('button', { name: 'Опубликовать' }))
    expect(onPublish).toHaveBeenCalledWith({ new: { title: 'Прайс' } })
  })

  it('waits for the publication: «Публикуем…», no second press, no closing', () => {
    const onClose = vi.fn()
    const { onPublish } = show({ pending: true, onClose })
    const button = screen.getByRole('button', { name: 'Публикуем…' })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    expect(onPublish).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Отмена' })).toHaveProperty('disabled', true)
  })

  it('offers no version when there is no published page', () => {
    show({ pages: [] })
    expect(screen.getByRole('radio', { name: 'Новой версией страницы' })).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByText('Опубликованных страниц пока нет.')).toBeTruthy()
  })
})
