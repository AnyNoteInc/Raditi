'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { DocumentMarkdown } from '@repo/doc-render/markdown'
import { artifactRoleAtLeast, tableCellText, tableOfBlocks } from '@repo/domain/artifacts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC } from '@/trpc/client'

import type { ArtifactBodyProps } from '../artifact-body-props'
import type { CabinetArtifact } from '../use-artifact'

// «Отчёт» in the cabinet (docs/plan/88-artifacts.md, §7.7, §7.13; slice 88.28): its sections of
// Markdown, its charts — the pictures the server drew of their specs —, and its table, in the order
// of the blocks. A person changes the text of a section; the charts and the table are the agent's.

export const reportTexts = Object.freeze({
  empty: 'Отчёт пока пуст. Попросите агента собрать отчёт с графиками и таблицей.',
  edit: 'Править текст',
  save: 'Сохранить',
  cancel: 'Отмена',
  heading: 'Заголовок раздела',
  text: 'Текст раздела',
  drawing: 'Рисуем график…',
  chartFailed: 'График не нарисован: в его данных ошибка. Попросите агента исправить.',
  checking: 'Агент дописывает этот блок: покажем после проверки.',
  failed: 'Не получилось сохранить. Попробуйте ещё раз.',
  stale: 'Раздел только что изменили. Откройте правку заново.',
})

type Block = CabinetArtifact['blocks'][number]

const domainCodeOf = (error: unknown) =>
  (error as { data?: { domainCode?: string } } | null)?.data?.domainCode

function ReportChart({ artifactId, block }: { artifactId: string; block: Block }) {
  const trpc = useTRPC()
  const chart = useQuery(
    trpc.artifact.chart.queryOptions({ artifactId, block: block.key, rev: block.rev }),
  )
  if (!chart.data)
    return (
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', color: 'text.secondary' }}>
        <CircularProgress size={16} />
        <Typography variant="body2">{reportTexts.drawing}</Typography>
      </Box>
    )
  if (chart.data.state === 'failed')
    return <Alert severity="warning">{reportTexts.chartFailed}</Alert>
  return (
    <Box
      component="img"
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(chart.data.svg)}`}
      width={chart.data.width}
      height={chart.data.height}
      alt=""
      sx={{
        display: 'block',
        maxWidth: '100%',
        height: 'auto',
        bgcolor: '#fff',
        borderRadius: '8px',
      }}
    />
  )
}

function ReportTable({ blocks }: { blocks: readonly Block[] }) {
  const table = tableOfBlocks(blocks)
  if (table.columns.length === 0) return null
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Box
        component="table"
        sx={{
          borderCollapse: 'collapse',
          minWidth: '100%',
          '& th, & td': { border: 1, borderColor: 'divider', px: 1.5, py: 0.75, textAlign: 'left' },
          '& th': { bgcolor: 'background.paper', fontWeight: 650 },
        }}
      >
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th key={column.key} scope="col">
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.key}>
              {table.columns.map((column) => (
                <td key={column.key}>{tableCellText(column, row.cells[column.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </Box>
    </Box>
  )
}

function ReportSection({
  artifactId,
  block,
  canEdit,
  onChanged,
}: {
  artifactId: string
  block: Block
  canEdit: boolean
  onChanged: () => void
}) {
  const trpc = useTRPC()
  const write = useMutation(trpc.artifact.write.mutationOptions())
  const [editing, setEditing] = useState(false)
  const [heading, setHeading] = useState(block.heading ?? '')
  const [text, setText] = useState(block.content ?? '')
  const [problem, setProblem] = useState<string | null>(null)

  async function save() {
    try {
      await write.mutateAsync({
        batch: {
          artifactId,
          opId: uuidv7(),
          ops: [
            {
              op: 'replace',
              block: block.key,
              ifRev: block.rev,
              content: text,
              props: { heading: heading.trim() },
            },
          ],
        },
      })
      setEditing(false)
      onChanged()
    } catch (error) {
      setProblem(domainCodeOf(error) === 'ARTIFACT_STALE' ? reportTexts.stale : reportTexts.failed)
    }
  }

  if (editing)
    return (
      <Box component="section" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <TextField
          label={reportTexts.heading}
          value={heading}
          onChange={(event) => setHeading(event.target.value)}
          size="small"
        />
        <TextField
          label={reportTexts.text}
          value={text}
          onChange={(event) => setText(event.target.value)}
          multiline
          minRows={4}
        />
        {problem && <Alert severity="error">{problem}</Alert>}
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button variant="contained" disabled={write.isPending} onClick={() => void save()}>
            {reportTexts.save}
          </Button>
          <Button onClick={() => setEditing(false)}>{reportTexts.cancel}</Button>
        </Box>
      </Box>
    )
  return (
    <Box component="section">
      {block.heading && (
        <Typography component="h2" variant="h6" sx={{ mb: 1 }}>
          {block.heading}
        </Typography>
      )}
      <DocumentMarkdown
        text={block.content ?? ''}
        documents={new Set<string>()}
        imageSrc={() => null}
        documentLinks={false}
      />
      {canEdit && block.hold === null && (
        <Button size="small" onClick={() => setEditing(true)}>
          {reportTexts.edit}
        </Button>
      )}
    </Box>
  )
}

export function ArtifactReport(props: ArtifactBodyProps & { onAccessLost: () => void }) {
  const { artifact, onChanged } = props
  const canEdit = artifactRoleAtLeast(artifact.role, 'edit')
  const top = artifact.blocks.filter((block) => block.parent === null)
  if (top.length === 0)
    return <Typography sx={{ color: 'text.secondary' }}>{reportTexts.empty}</Typography>
  // A table is its columns and rows together, shown where its columns stand.
  const tableBlocks = top.filter((block) => block.kind === 'columns' || block.kind === 'row')
  const tableAt = top.findIndex((block) => block.kind === 'columns')
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 820 }}>
      {top.map((block, index) => {
        if (block.checking && block.content === null)
          return (
            <Typography key={block.key} variant="body2" sx={{ color: 'text.secondary' }}>
              {reportTexts.checking}
            </Typography>
          )
        if (block.kind === 'section')
          return (
            <ReportSection
              key={`${block.key}:${block.rev}`}
              artifactId={artifact.id}
              block={block}
              canEdit={canEdit}
              onChanged={onChanged}
            />
          )
        if (block.kind === 'chart')
          return <ReportChart key={block.key} artifactId={artifact.id} block={block} />
        if (block.kind === 'columns' && index === tableAt)
          return <ReportTable key={block.key} blocks={tableBlocks} />
        return null
      })}
    </Box>
  )
}
