// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { closedTools, toolsReducer, type ToolsAction, type ToolsState } from './dialog-tools'
import { ToolsPanel } from './tools-panel'

// The panel of the tools (docs/plan/59-dialog-tools-panel.md, И7, И8, И14): its tabs — a sign and a
// name each, as on the mockups, the sign 8px before the name — and its ways back to the dialog.

const after = (...actions: ToolsAction[]): ToolsState => actions.reduce(toolsReducer, closedTools)
const open = (tool: 'files' | 'preview'): ToolsAction => ({ type: 'open', tool, by: 'menu' })

function showPanel(tools: ToolsState, { wide }: { wide: boolean }) {
  const handlers = { onShow: vi.fn(), onClose: vi.fn(), onCloseAll: vi.fn(), onBack: vi.fn() }
  const { container } = render(
    <ToolsPanel
      tools={tools}
      pane={createRef<HTMLElement>()}
      wide={wide}
      fullscreen={false}
      menu={null}
      {...handlers}
      content={(tool) => <p>{`Содержимое ${tool}`}</p>}
    />,
  )
  return { handlers, container }
}

describe('a tab of the panel of the tools', () => {
  it('puts the sign of its tool 8px before the name', () => {
    showPanel(after(open('files')), { wide: false })
    const tab = screen.getByRole('tab', { name: 'Файлы' })
    const sign = tab.querySelector(':scope > svg')
    expect(sign).not.toBeNull()
    expect(getComputedStyle(sign!).marginRight).toBe('8px')
  })
})

describe('the ways back to the dialog (И8, И14)', () => {
  it('goes back by «К диалогу» below `lg`: the dialog is told to put the tab away, not every tab', () => {
    const { handlers } = showPanel(after(open('preview'), open('files')), { wide: false })
    expect(screen.queryByRole('button', { name: 'Скрыть панель' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'К диалогу' }))
    expect(handlers.onBack).toHaveBeenCalledTimes(1)
    expect(handlers.onCloseAll).not.toHaveBeenCalled()
    expect(handlers.onClose).not.toHaveBeenCalled()
  })

  it('hides every tab by «Скрыть панель» from `lg`, where there is no «К диалогу»', () => {
    const { handlers } = showPanel(after(open('preview'), open('files')), { wide: true })
    expect(screen.queryByRole('button', { name: 'К диалогу' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть панель' }))
    expect(handlers.onCloseAll).toHaveBeenCalledTimes(1)
    expect(handlers.onBack).not.toHaveBeenCalled()
  })

  it('draws nothing while its tabs wait behind the dialog, nor while none is open', () => {
    const behind = after(open('preview'), open('files'), { type: 'back' })
    expect(behind.open).toEqual(['preview'])
    expect(showPanel(behind, { wide: false }).container.innerHTML).toBe('')
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(screen.queryByText('Содержимое preview')).toBeNull()
    expect(showPanel(closedTools, { wide: true }).container.innerHTML).toBe('')
    // Chosen again: drawn with the tab kept.
    showPanel(toolsReducer(behind, open('preview')), { wide: false })
    expect(screen.getByRole('complementary', { name: 'Инструменты диалога' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Предпросмотр' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByText('Содержимое preview')).toBeTruthy()
  })
})
