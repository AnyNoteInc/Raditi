'use client'

import Box from '@mui/material/Box'
import TextField from '@mui/material/TextField'
import { documentToMarkdown, sectionToDocument, type EditorNode } from '@repo/doc-bridge'
import {
  MenuButtonBlockquote,
  MenuButtonBold,
  MenuButtonBulletedList,
  MenuButtonAddTable,
  MenuButtonItalic,
  MenuButtonOrderedList,
  MenuButtonRedo,
  MenuButtonStrikethrough,
  MenuButtonTaskList,
  MenuButtonUndo,
  MenuControlsContainer,
  MenuDivider,
  MenuSelectHeading,
  RichTextEditor,
  type RichTextEditorRef,
} from 'mui-tiptap'
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'

import { editorTexts } from '../artifact-texts'
import { sectionExtensions } from './extensions'

// The editor of one section (docs/plan/88-artifacts.md, §7.7, board C-doc): Tiptap under
// mui-tiptap in the colours of the cabinet, a toolbar in Russian (rule 10), Markdown in and out
// through the bridge of @repo/doc-bridge — never `@tiptap/markdown`. What it saves is the
// canonical form, so a second load shows the same document.

export interface SectionEditorHandle {
  /** The text as Markdown in the canonical form, and the heading. */
  value(): { heading: string; content: string }
  /** Loads another text into the editor (after a merge, or «Взять другой»). */
  load(content: string): void
  focus(): void
}

export const SectionEditor = forwardRef<
  SectionEditorHandle,
  {
    heading: string
    content: string
    onChange: () => void
    onHeading: (heading: string) => void
    label: string
    /** False while an agent holds the section: the text stays, nothing is typed. */
    editable?: boolean
  }
>(function SectionEditor({ heading, content, onChange, onHeading, label, editable = true }, ref) {
  const editor = useRef<RichTextEditorRef>(null)
  const extensions = useMemo(() => sectionExtensions(), [])
  const initial = useMemo(() => sectionToDocument(content), [content])
  const headingRef = useRef(heading)
  headingRef.current = heading

  useImperativeHandle(ref, () => ({
    value: () => {
      const json = editor.current?.editor?.getJSON() as EditorNode | undefined
      return {
        heading: headingRef.current.trim(),
        content: json ? documentToMarkdown(json) : content,
      }
    },
    load: (next) => {
      editor.current?.editor?.commands.setContent(sectionToDocument(next) as never, {
        emitUpdate: false,
      })
    },
    focus: () => editor.current?.editor?.commands.focus('end'),
  }))

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <TextField
        size="small"
        label={editorTexts.heading}
        value={heading}
        disabled={!editable}
        onChange={(event) => {
          onHeading(event.target.value)
          onChange()
        }}
        slotProps={{ htmlInput: { maxLength: 200 } }}
      />
      <Box
        sx={{
          '& .ProseMirror': { minHeight: 120, fontSize: 15, lineHeight: 1.6 },
          '& .ProseMirror table': { borderCollapse: 'collapse' },
          '& .ProseMirror td, & .ProseMirror th': {
            border: 1,
            borderColor: 'divider',
            px: 1,
            py: 0.5,
          },
        }}
      >
        <RichTextEditor
          ref={editor}
          extensions={extensions}
          content={initial as never}
          immediatelyRender={false}
          editable={editable}
          onUpdate={() => onChange()}
          editorProps={{ attributes: { 'aria-label': label, spellcheck: 'true' } }}
          renderControls={() => (
            <MenuControlsContainer>
              <MenuSelectHeading
                aria-label={editorTexts.style}
                labels={{
                  paragraph: editorTexts.paragraph,
                  heading3: editorTexts.headingLevel(3),
                  heading4: editorTexts.headingLevel(4),
                  heading5: editorTexts.headingLevel(5),
                  heading6: editorTexts.headingLevel(6),
                  empty: editorTexts.paragraph,
                }}
              />
              <MenuDivider />
              <MenuButtonBold tooltipLabel={editorTexts.bold} />
              <MenuButtonItalic tooltipLabel={editorTexts.italic} />
              <MenuButtonStrikethrough tooltipLabel={editorTexts.strike} />
              <MenuDivider />
              <MenuButtonBulletedList tooltipLabel={editorTexts.bullets} />
              <MenuButtonOrderedList tooltipLabel={editorTexts.numbers} />
              <MenuButtonTaskList tooltipLabel={editorTexts.tasks} />
              <MenuButtonBlockquote tooltipLabel={editorTexts.quote} />
              <MenuButtonAddTable tooltipLabel={editorTexts.table} />
              <MenuDivider />
              <MenuButtonUndo tooltipLabel={editorTexts.undo} />
              <MenuButtonRedo tooltipLabel={editorTexts.redo} />
            </MenuControlsContainer>
          )}
        />
      </Box>
    </Box>
  )
})
