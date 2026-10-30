// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { closedTools, toolsReducer } from './dialog-tools'
import { ToolsPanel } from './tools-panel'

// The tabs of the panel of the tools (docs/plan/59-dialog-tools-panel.md, И7): a sign and a name
// each, as on the mockups — the sign 8px before the name.

describe('a tab of the panel of the tools', () => {
  it('puts the sign of its tool 8px before the name', () => {
    const tools = toolsReducer(closedTools, { type: 'open', tool: 'files', by: 'menu' })
    render(
      <ToolsPanel
        tools={tools}
        pane={createRef<HTMLElement>()}
        wide={false}
        fullscreen={false}
        menu={null}
        onShow={vi.fn()}
        onClose={vi.fn()}
        onCloseAll={vi.fn()}
        content={() => null}
      />,
    )
    const tab = screen.getByRole('tab', { name: 'Файлы' })
    const sign = tab.querySelector(':scope > svg')
    expect(sign).not.toBeNull()
    expect(getComputedStyle(sign!).marginRight).toBe('8px')
  })
})
