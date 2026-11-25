'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { artifactRoleAtLeast, diagramErrorRu } from '@repo/domain/artifacts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { uuidv7 } from '@/components/chat/uuid'
import {
  DiagramDrawing,
  DiagramImage,
  DiagramText,
  diagramPictureText,
} from '@/components/diagram/diagram-picture'
import { useTRPC } from '@/trpc/client'

import type { ArtifactBodyProps } from '../artifact-body-props'
import type { CabinetArtifact } from '../use-artifact'

// «Схема» in the cabinet (docs/plan/88-artifacts.md, §7.7, §7.13; slice 88.24в): the picture the
// server drew of the checked text — an SVG cleaned by DOMPurify, shown as `<img>` sized by its
// viewBox; Mermaid never runs in the cabinet. A text that did not parse shows its line and the text.
// «Править текст» writes the block with its revision; downloads are the same SVG and a PNG of it.

export const diagramTexts = Object.freeze({
  empty: 'Схемы пока нет. Попросите агента нарисовать её: путь клиента, процесс, структуру.',
  write: 'Написать текст',
  drawing: diagramPictureText.drawing,
  checking: 'Агент дописывает схему: покажем, как только платформа её проверит.',
  edit: 'Править текст',
  save: 'Сохранить',
  cancel: 'Отмена',
  text: 'Текст схемы (Mermaid)',
  showText: diagramPictureText.showText,
  svg: diagramPictureText.svg,
  png: diagramPictureText.png,
  failed: 'Не удалось сохранить. Попробуйте ещё раз.',
  stale: 'Схему только что изменили. Откройте правку заново.',
  secret: 'В тексте похоже на пароль или ключ: такое не сохраняется.',
})

/** How often the cabinet asks again while core draws: every 1.5 s, for a minute at most. */
const DRAWING_POLL_MS = 1500
const DRAWING_POLLS = 40

type DiagramBlock = CabinetArtifact['blocks'][number]

function DiagramPicture({ artifact, block }: { artifact: CabinetArtifact; block: DiagramBlock }) {
  const trpc = useTRPC()
  const picture = useQuery({
    // A new text is a new picture: the revision is in the input, the key of the query.
    ...trpc.artifact.diagram.queryOptions({
      artifactId: artifact.id,
      block: block.key,
      rev: block.rev,
    }),
    refetchInterval: (query) =>
      query.state.data?.state === 'drawing' && query.state.dataUpdateCount < DRAWING_POLLS
        ? DRAWING_POLL_MS
        : false,
  })
  const data = picture.data
  if (!data || data.state === 'drawing') return <DiagramDrawing />
  if (data.state === 'empty')
    return <Typography sx={{ color: 'text.secondary' }}>{diagramTexts.empty}</Typography>
  if (data.state === 'failed')
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Alert severity="warning">{diagramErrorRu(data.line)}</Alert>
        <DiagramText text={block.content ?? ''} line={data.line} label={diagramTexts.text} />
      </Box>
    )
  return (
    <DiagramImage
      svg={data.svg}
      width={data.width}
      height={data.height}
      alt={artifact.title}
      fileTitle={artifact.title}
      text={block.content ?? ''}
      textLabel={diagramTexts.text}
    />
  )
}

function DiagramEditor({
  artifact,
  block,
  onDone,
}: {
  artifact: CabinetArtifact
  /** null — an empty diagram: the text becomes its first block. */
  block: DiagramBlock | null
  onDone: (saved: boolean) => void
}) {
  const trpc = useTRPC()
  const write = useMutation(trpc.artifact.write.mutationOptions())
  const [text, setText] = useState(block?.content ?? '')
  const [problem, setProblem] = useState<string | null>(null)

  async function save() {
    try {
      await write.mutateAsync({
        batch: {
          artifactId: artifact.id,
          opId: uuidv7(),
          ops: [
            block
              ? { op: 'replace', block: block.key, ifRev: block.rev, content: text }
              : { op: 'insert', after: null, kind: 'diagram', content: text },
          ],
        },
      })
      onDone(true)
    } catch (error) {
      const code = (error as { data?: { domainCode?: string } } | null)?.data?.domainCode
      setProblem(
        code === 'ARTIFACT_STALE'
          ? diagramTexts.stale
          : code === 'ARTIFACT_SECRET_SHAPE'
            ? diagramTexts.secret
            : diagramTexts.failed,
      )
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <TextField
        label={diagramTexts.text}
        value={text}
        onChange={(event) => setText(event.target.value)}
        multiline
        minRows={8}
        maxRows={24}
        slotProps={{
          htmlInput: { spellCheck: false, style: { fontFamily: 'monospace', fontSize: 13 } },
        }}
      />
      {problem && <Alert severity="error">{problem}</Alert>}
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button
          variant="contained"
          disabled={write.isPending || text.trim() === '' || text === (block?.content ?? '')}
          onClick={() => void save()}
        >
          {diagramTexts.save}
        </Button>
        <Button onClick={() => onDone(false)}>{diagramTexts.cancel}</Button>
      </Box>
    </Box>
  )
}

export function ArtifactDiagram(props: ArtifactBodyProps & { onAccessLost: () => void }) {
  const { artifact, onChanged } = props
  const canEdit = artifactRoleAtLeast(artifact.role, 'edit')
  const blocks = artifact.blocks.filter(
    (block) => block.kind === 'diagram' && block.parent === null,
  )
  const [editing, setEditing] = useState<string | null>(null)

  if (blocks.length === 0)
    return editing === '' ? (
      <DiagramEditor
        artifact={artifact}
        block={null}
        onDone={(saved) => {
          setEditing(null)
          if (saved) onChanged()
        }}
      />
    ) : (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start' }}>
        <Typography sx={{ color: 'text.secondary' }}>{diagramTexts.empty}</Typography>
        {canEdit && <Button onClick={() => setEditing('')}>{diagramTexts.write}</Button>}
      </Box>
    )
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {blocks.map((block) => (
        <Box
          key={block.key}
          component="section"
          sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}
        >
          {block.checking && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {diagramTexts.checking}
            </Typography>
          )}
          {editing === block.key ? (
            <DiagramEditor
              artifact={artifact}
              block={block}
              onDone={(saved) => {
                setEditing(null)
                if (saved) onChanged()
              }}
            />
          ) : (
            <>
              <DiagramPicture artifact={artifact} block={block} />
              {canEdit && !block.checking && block.hold === null && (
                <Box>
                  <Button size="small" onClick={() => setEditing(block.key)}>
                    {diagramTexts.edit}
                  </Button>
                </Box>
              )}
            </>
          )}
        </Box>
      ))}
    </Box>
  )
}
