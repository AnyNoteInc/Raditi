'use client'

import { dbColumnTypeText } from '@repo/domain/release/db-objects'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'

import { paletteOf } from '@/components/billing/billing-surface'
import { nbsp } from '@/lib/nbsp'

import {
  databaseText,
  dbFieldWords,
  dbNewRecordText,
  dbRecordWord,
  filesText,
  ownText,
} from './chat-texts'
import type { CandidateView } from './chat-types'
import { offScreen } from './composer'

// «База данных» beside a dialog and in the window of `/release` (docs/plan/53, «Операции БД и
// миграции»): every operation of the plan with its values, new and old, as core described them
// with the revision — a text by the difference of its words, a setting «было → станет», a new
// page by its title and address, a table by its columns. What the server sent is only ever set
// as text; nothing of it is markup here.

type DbView = NonNullable<CandidateView['databaseView']>
type Card = DbView['operations'][number]
type TextCard = Extract<Card, { kind: 'content_update'; fields: unknown }>
type Hunk = NonNullable<TextCard['content']>
type Field = NonNullable<TextCard['excerpt']>

/** «было «…», станет «…»»; an old value that was not there or empty — «было: не задано». */
function change(before: string | null, after: string): string {
  const was =
    before === null || before === ''
      ? `${databaseText.was}: ${databaseText.notSet}`
      : `${databaseText.was} «${before}»`
  return `${was}, ${databaseText.becomes} «${after}»`
}

function Line({ children }: { children: ReactNode }) {
  return (
    <Typography variant="body2" sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
      {children}
    </Typography>
  )
}

/** The difference of a text by words: kept words plain, added and removed ones marked. */
function TextDifference({ content }: { content: Hunk }) {
  if (content.markupOnly) return <Line>{databaseText.markupOnly}</Line>
  if (content.hunks === null)
    return (
      <>
        <Line>{databaseText.replaced}</Line>
        {content.replaced ? (
          <Line>{change(content.replaced.before, content.replaced.after)}</Line>
        ) : null}
      </>
    )
  return (
    <Box
      sx={(theme) => {
        const palette = paletteOf(theme)
        return {
          fontSize: 14,
          lineHeight: 1.6,
          overflowWrap: 'anywhere',
          whiteSpace: 'pre-wrap',
          // A tint of the theme's own success and error roles, and a line besides the colour.
          '& ins': {
            textDecoration: 'none',
            borderBottom: `2px solid ${palette.success.main}`,
            backgroundColor: `color-mix(in srgb, ${palette.success.main} 16%, transparent)`,
          },
          '& del': {
            backgroundColor: `color-mix(in srgb, ${palette.error.main} 14%, transparent)`,
          },
          '& [data-said]': offScreen,
        }
      }}
    >
      {content.hunks.map((hunk, index) =>
        hunk.op === 'add' ? (
          <ins key={index}>
            <span data-said="">{filesText.added} </span>
            {hunk.text}
          </ins>
        ) : hunk.op === 'del' ? (
          <del key={index}>
            <span data-said="">{filesText.removed} </span>
            {hunk.text}
          </del>
        ) : hunk.op === 'gap' ? (
          <span key={index}> … </span>
        ) : (
          <span key={index}>{hunk.text}</span>
        ),
      )}
    </Box>
  )
}

function Links({ label, links }: { label: string; links: readonly string[] }) {
  if (links.length === 0) return null
  return <Line>{`${label}: ${links.join(', ')}`}</Line>
}

/** A title or an excerpt: «было → станет», or that only its markup changed, and its links. */
function FieldChange({ label, field }: { label: string; field: Field }) {
  return (
    <>
      <Line>
        {field.markupOnly
          ? `${label}: ${databaseText.fieldMarkupOnly}`
          : `${label}: ${change(field.before, field.after)}`}
      </Line>
      <Links label={databaseText.linksAdded} links={field.links.added} />
      <Links label={databaseText.linksRemoved} links={field.links.removed} />
    </>
  )
}

/** The heading and the values of one operation. */
function CardBody({ card }: { card: Card }) {
  if ('refused' in card) return <Line>{ownText(databaseText.refused, card.refused) ?? ''}</Line>
  switch (card.kind) {
    case 'content_update': {
      const words = card.fields.map((field) => dbFieldWords[field])
      const listed =
        words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} и ${words.at(-1)}`
      const verb = card.fields.length > 1 ? 'изменятся' : 'изменится'
      return (
        <>
          <Heading>{`${dbRecordWord(card.record.type)} «${card.record.title}»: ${verb} ${listed}`}</Heading>
          {card.title ? <FieldChange label={databaseText.title} field={card.title} /> : null}
          {card.excerpt ? <FieldChange label={databaseText.excerpt} field={card.excerpt} /> : null}
          {card.content ? (
            <>
              <Line>{`${databaseText.text}:`}</Line>
              <TextDifference content={card.content} />
              <Links label={databaseText.linksAdded} links={card.content.links.added} />
              <Links label={databaseText.linksRemoved} links={card.content.links.removed} />
            </>
          ) : null}
        </>
      )
    }
    case 'option_update':
      return <Heading>{`${card.label}: ${change(card.before, card.after)}`}</Heading>
    case 'post_create':
      return (
        <>
          <Heading>{dbNewRecordText(card.record.type, card.title, card.slug)}</Heading>
          <Line>{card.status === 'publish' ? databaseText.published : databaseText.draft}</Line>
          {card.excerpt ? <Line>{`${databaseText.excerpt}: ${card.excerpt}`}</Line> : null}
          {card.contentText ? <Line>{`${databaseText.text}: ${card.contentText}`}</Line> : null}
          <Links label={databaseText.linksIn} links={card.links} />
        </>
      )
    case 'schema_migration':
      return (
        <>
          <Heading>
            {card.created ? databaseText.newTable(card.table) : databaseText.newColumns(card.table)}
          </Heading>
          {card.columns.length > 0 ? (
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              {card.columns.map((column) => {
                const given = column.default
                const parts = [`${column.name} — ${dbColumnTypeText(column)}`]
                if (column.nullable) parts.push(databaseText.maybeEmpty)
                if (given && 'now' in given) parts.push(databaseText.defaultNow)
                else if (given) parts.push(`${databaseText.defaultValue}: ${given.value}`)
                return (
                  <li key={column.name}>
                    <Line>{parts.join(', ')}</Line>
                  </li>
                )
              })}
            </Box>
          ) : null}
          {card.indexes.map((index) => (
            <Line key={index.name}>
              {index.unique
                ? databaseText.uniqueIndex(index.columns.join(', '))
                : databaseText.index(index.columns.join(', '))}
            </Line>
          ))}
        </>
      )
  }
}

function Heading({ children }: { children: string }) {
  return (
    <Typography sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{nbsp(children)}</Typography>
  )
}

/** Whether a card says something is cut short. */
function shortened(card: Card): boolean {
  if ('refused' in card) return false
  if (card.kind === 'content_update')
    return Boolean(card.title?.truncated || card.excerpt?.truncated || card.content?.truncated)
  return 'truncated' in card && card.truncated
}

/** «База данных»: how the database of the site will change, value by value. */
export function DatabasePanel({ candidate }: { candidate: CandidateView }) {
  const view = candidate.databaseView
  if (view === null) {
    if (candidate.database.length === 0)
      return <Typography color="text.secondary">{databaseText.none}</Typography>
    // A plan without its values: what it touches, in the platform's words, and why no release.
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Typography role="note">{nbsp(databaseText.noValues)}</Typography>
        <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'grid', gap: 0.75 }}>
          {candidate.database.map((item, index) => (
            <li key={index}>
              <Typography sx={{ overflowWrap: 'anywhere' }}>{nbsp(item.text)}</Typography>
            </li>
          ))}
        </Box>
      </Box>
    )
  }
  if (view.oversize) return <Typography role="note">{nbsp(databaseText.oversize)}</Typography>
  if (view.operations.length === 0)
    return <Typography color="text.secondary">{databaseText.none}</Typography>
  const keeps = view.operations.some(
    (card) => card.kind === 'post_create' || card.kind === 'schema_migration',
  )
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Typography variant="body2" color="text.secondary">
        {databaseText.note}
      </Typography>
      <Box component="ol" sx={{ m: 0, p: 0, listStyle: 'none', display: 'grid', gap: 1 }}>
        {view.operations.map((card) => (
          <Box
            component="li"
            key={card.index}
            sx={{
              display: 'grid',
              gap: 0.5,
              p: 1.5,
              border: 1,
              borderColor: 'refused' in card ? 'error.main' : 'divider',
              borderRadius: '12px',
              minWidth: 0,
            }}
          >
            <CardBody card={card} />
            {shortened(card) ? (
              <Typography variant="body2" color="text.secondary">
                {databaseText.shortened}
              </Typography>
            ) : null}
          </Box>
        ))}
      </Box>
      {keeps ? (
        <Typography variant="body2" color="text.secondary">
          {nbsp(databaseText.returnNote)}
        </Typography>
      ) : null}
    </Box>
  )
}
