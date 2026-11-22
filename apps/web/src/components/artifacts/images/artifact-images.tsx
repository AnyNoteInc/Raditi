'use client'

import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import {
  artifactFrameSizeOf,
  artifactImageSizeNames,
  artifactImageSizeOf,
  artifactImageSizes,
  artifactRoleAtLeast,
  canvasScreensOf,
  type ArtifactImageSize,
  type ArtifactOp,
} from '@repo/domain/artifacts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { uuidv7 } from '@/components/chat/uuid'
import { useTRPC, useTRPCClient } from '@/trpc/client'

import type { ArtifactBodyProps } from '../artifact-body-props'
import { ArtifactMockup } from '../mockup/artifact-mockup'

// «Изображение» in the cabinet (docs/plan/88-artifacts.md, §7.7, §7.13; slice 88.26б): pictures made
// of HTML in the sizes of their places — a post, a story, a cover, a banner —, without a model that
// draws. The pictures by the thumbnails core draws, the chosen one in its own size as the frame of a
// mockup («Править текст», the photos of «Файлы»), its size, a new picture, and «Скачать PNG».

export const imagesTexts = Object.freeze({
  empty:
    'Изображений пока нет. Попросите агента сделать пост или баннер, или добавьте изображение.',
  pictures: 'Изображения',
  size: 'Размер',
  add: 'Добавить изображение',
  png: 'Скачать PNG',
  preparing: 'Готовим файл…',
  failed: 'Не получилось сохранить. Попробуйте ещё раз.',
  stale: 'Изображение только что изменили. Обновите и повторите.',
  exportFailed: 'Не получилось подготовить файл. Попробуйте ещё раз.',
  newPicture: 'Новое изображение',
  newPictureHtml:
    '<section class="picture"><h1>Заголовок</h1><p>Одна короткая строка о главном.</p></section>',
})

const EXPORT_POLL_MS = 1500
const EXPORT_POLLS = 40

const domainCodeOf = (error: unknown) =>
  (error as { data?: { domainCode?: string } } | null)?.data?.domainCode

const newKey = () => `pic${uuidv7().replace(/-/g, '').slice(-8)}`

export function ArtifactImages(props: ArtifactBodyProps & { onAccessLost: () => void }) {
  const { artifact, onChanged, place } = props
  const trpc = useTRPC()
  const client = useTRPCClient()
  const canEdit = artifactRoleAtLeast(artifact.role, 'edit')
  const pictures = canvasScreensOf(artifact.blocks)
  const [chosen, setChosen] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const write = useMutation(trpc.artifact.write.mutationOptions())
  const exportStart = useMutation(trpc.artifact.exportStart.mutationOptions())
  const thumbs = useQuery({
    ...trpc.artifact.canvasThumbs.queryOptions({ artifactId: artifact.id, seq: artifact.seq }),
    refetchInterval: (query) => (query.state.data?.pending ? 3000 : false),
    enabled: pictures.length > 0,
  })
  const picture = pictures.find((each) => each.key === chosen) ?? pictures[0] ?? null
  const frameOf = (key: string) => artifact.blocks.find((block) => block.key === key)
  const sizeOf = (key: string) => artifactImageSizeOf(frameOf(key)?.props)
  const thumbOf = (key: string) =>
    thumbs.data?.thumbs.find((each) => each.frame === key)?.url ?? null

  async function apply(ops: ArtifactOp[]) {
    setProblem(null)
    try {
      await write.mutateAsync({ batch: { artifactId: artifact.id, opId: uuidv7(), ops } })
      onChanged()
    } catch (error) {
      setProblem(domainCodeOf(error) === 'ARTIFACT_STALE' ? imagesTexts.stale : imagesTexts.failed)
    }
  }

  function resize(key: string, size: ArtifactImageSize) {
    const frame = frameOf(key)
    if (!frame) return
    void apply([
      {
        op: 'replace',
        block: key,
        ifRev: frame.rev,
        content: frame.content ?? '',
        props: { ...(frame.props as Record<string, string | number | boolean>), size },
      },
    ])
  }

  function add() {
    const key = newKey()
    void apply([
      {
        op: 'insert',
        block: key,
        after: picture?.key ?? null,
        kind: 'frame',
        content: '',
        props: { name: imagesTexts.newPicture, size: 'post' },
      },
      {
        op: 'insert',
        block: `${key}-html`,
        after: null,
        parent: key,
        kind: 'html',
        content: imagesTexts.newPictureHtml,
      },
    ])
    setChosen(key)
  }

  /** «Скачать PNG»: core draws the picture in its own size (88.26). */
  async function download(frame: string) {
    setPreparing(true)
    setProblem(null)
    try {
      const { exportId } = await exportStart.mutateAsync({
        artifactId: artifact.id,
        format: 'png',
        frame,
      })
      for (let poll = 0; poll < EXPORT_POLLS; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_MS))
        const { state } = await client.artifact.exportStatus.query({ exportId })
        if (state === 'ready') {
          const link = document.createElement('a')
          link.href = `/api/artifact-exports/${exportId}`
          document.body.append(link)
          link.click()
          link.remove()
          return
        }
        if (state === 'failed') break
      }
      setProblem(imagesTexts.exportFailed)
    } catch {
      setProblem(imagesTexts.exportFailed)
    } finally {
      setPreparing(false)
    }
  }

  if (pictures.length === 0)
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start' }}>
        <Typography sx={{ color: 'text.secondary' }}>{imagesTexts.empty}</Typography>
        {canEdit && <Button onClick={add}>{imagesTexts.add}</Button>}
      </Box>
    )

  const size = picture ? artifactFrameSizeOf('image', frameOf(picture.key)?.props) : null
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: place === 'pane' ? 'column' : 'row',
        gap: 2,
        alignItems: 'flex-start',
      }}
    >
      <Box
        component="nav"
        aria-label={imagesTexts.pictures}
        sx={{
          display: 'flex',
          flexDirection: place === 'pane' ? 'row' : 'column',
          gap: 1,
          flex: '0 0 auto',
          overflow: 'auto',
          maxWidth: place === 'pane' ? '100%' : 200,
          maxHeight: place === 'pane' ? undefined : '80vh',
        }}
      >
        {pictures.map((each) => {
          const own = artifactImageSizes[sizeOf(each.key)]
          const url = thumbOf(each.key)
          return (
            <Box
              key={each.key}
              component="button"
              type="button"
              aria-current={each.key === picture?.key ? 'true' : undefined}
              aria-label={`${each.name}, ${own.label}`}
              onClick={() => setChosen(each.key)}
              sx={{
                flex: '0 0 auto',
                width: 176,
                p: 0.5,
                border: 2,
                borderColor: each.key === picture?.key ? 'primary.main' : 'divider',
                borderRadius: '8px',
                bgcolor: 'background.paper',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <Box
                sx={{
                  width: 160,
                  aspectRatio: `${own.width} / ${own.height}`,
                  maxHeight: 200,
                  bgcolor: '#fff',
                  borderRadius: '4px',
                  overflow: 'hidden',
                  mx: 'auto',
                }}
              >
                {url && (
                  <Box
                    component="img"
                    src={url}
                    alt=""
                    sx={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover' }}
                  />
                )}
              </Box>
              <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }} noWrap>
                {each.name} · {own.label}
              </Typography>
            </Box>
          )
        })}
      </Box>
      <Box sx={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {picture && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
            <TextField
              select
              size="small"
              label={imagesTexts.size}
              value={sizeOf(picture.key)}
              disabled={!canEdit || write.isPending}
              onChange={(event) => resize(picture.key, event.target.value as ArtifactImageSize)}
              sx={{ minWidth: 260 }}
            >
              {artifactImageSizeNames.map((name) => (
                <MenuItem key={name} value={name}>
                  {artifactImageSizes[name].label} · {artifactImageSizes[name].width}×
                  {artifactImageSizes[name].height}
                </MenuItem>
              ))}
            </TextField>
            <Button
              variant="contained"
              onClick={() => void download(picture.key)}
              disabled={preparing}
            >
              {preparing ? imagesTexts.preparing : imagesTexts.png}
            </Button>
            {canEdit && (
              <Button onClick={add} disabled={write.isPending}>
                {imagesTexts.add}
              </Button>
            )}
          </Box>
        )}
        {problem && <Alert severity="error">{problem}</Alert>}
        {picture && size && (
          <ArtifactMockup
            key={`${picture.key}:${size.width}x${size.height}`}
            {...props}
            frame={picture.key}
            slide={{ width: size.width, height: size.height }}
          />
        )}
      </Box>
    </Box>
  )
}
