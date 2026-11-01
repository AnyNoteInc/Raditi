import { feedFailureTextOf } from './client-feed-failures.ts'
import {
  feedApprovalSiteText,
  feedBrowserQuestionTextOf,
  feedBrowserQuestionTitle,
  feedCancelledSentence,
  feedCandidateText,
  feedCandidateVersionText,
  feedCardTitle,
  feedCeilingText,
  feedCommandText,
  feedCreditsSentence,
  feedDecisionText,
  feedDoneSiteText,
  feedEndedSiteText,
  feedFailureKeptText,
  feedFailureOpenText,
  feedFilesChangedText,
  feedMediaAddedText,
  feedObjectKindLabel,
  feedObjectStatusLabel,
  feedObjectText,
  FEED_QUEUE_TIMEOUT_CLOSING,
  feedRecordsChangedText,
  feedReleaseKeptText,
  feedReleaseReasonText,
  feedReleaseText,
  feedReleaseTitle,
  feedRowText,
  feedUndoConfirmedText,
  feedUndoKeptText,
  feedUndoReasonText,
  feedUndoText,
  feedUndoTitle,
  feedUpdateText,
  feedUpdateTitle,
  feedVersionBumpLabel,
  taskStatusLabel,
} from './client-feed-labels.ts'
import type { FeedItem } from './client-feed.ts'

// `/export` (docs/plan/61-chats-first.md, §5.14): the rows of a chat as a Markdown file, in the
// words the screen shows them. Only what `task.feed` gives goes in, nothing of the agent's work
// behind it. The agent's messages are Markdown already, the client's words stand as written.

export const feedExportText = Object.freeze({
  /** A chat that has no name yet. */
  untitled: 'Чат',
  you: 'Вы',
  agent: 'Агент',
  files: (count: number) => `Прикреплено файлов: ${count}`,
  screenshot: (number: number) => `Снимок экрана № ${number}`,
})

const moment = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

/** Whose row it is and when, in the same place in every block. */
const heading = (who: string, at: string) => `**${who}** · ${moment.format(new Date(at))}`

const sentences = (parts: readonly (string | null | undefined)[]): string =>
  parts.filter((part) => part !== null && part !== undefined && part !== '').join(' ')

const block = (lines: readonly (string | null)[]): string =>
  lines.filter((line) => line !== null && line !== '').join('\n\n')

/** A press of the client: one line, like its row on the screen. */
const press = (row: FeedItem, text: string) =>
  block([heading(feedExportText.you, row.at), `_${text}_`])

type Objects = Extract<FeedItem, { type: 'feed.result' }>['objects']

function objectList(objects: Objects, title: string): string | null {
  if (objects === undefined || objects.length === 0) return null
  const lines = objects.map((object) => {
    const kind = object.kind === null ? feedObjectText.otherKind : feedObjectKindLabel[object.kind]
    const status =
      object.status === null
        ? ''
        : ` — ${feedObjectStatusLabel[object.status].toLocaleLowerCase('ru')}`
    const address = object.url === undefined ? '' : `: ${object.url}`
    return `- ${kind} «${object.title ?? feedObjectText.untitled}»${status}${address}`
  })
  return `${title}\n\n${lines.join('\n')}`
}

/** A request of the client. The switch has no way out: a new kind does not compile without words. */
function requestBlock(row: Extract<FeedItem, { type: 'feed.request' }>): string {
  switch (row.kind) {
    case 'first':
    case 'answer':
    case 'revision':
      return block([
        heading(feedExportText.you, row.at),
        row.text,
        (row.attachments?.length ?? 0) > 0
          ? feedExportText.files(row.attachments?.length ?? 0)
          : null,
      ])
    case 'retry':
      return press(row, feedRowText.retry)
    case 'continue':
      return press(row, feedRowText.continue)
    case 'resume':
      return press(row, feedRowText.resume)
    case 'command':
    case 'agent_command':
      return press(
        row,
        row.command === null ? feedRowText.otherRequest : feedCommandText[row.command],
      )
    case 'other':
      return row.text
        ? block([heading(feedExportText.you, row.at), row.text])
        : press(row, feedRowText.otherRequest)
  }
}

/** One row as a block of the file; null — the screen shows nothing of it either. */
function rowBlock(row: FeedItem, withSite: boolean): string | null {
  const agent = (title: string) => `${heading(feedExportText.agent, row.at)} · ${title}`
  switch (row.type) {
    case 'feed.request':
      return requestBlock(row)
    case 'feed.question':
      if (row.kind === 'ceiling')
        return block([agent(taskStatusLabel.awaiting_user), feedCeilingText(row)])
      if (row.kind === 'browser')
        return block([
          agent(feedBrowserQuestionTitle[row.reason]),
          feedBrowserQuestionTextOf(row.reason, withSite),
          row.message ?? null,
        ])
      return block([
        agent(feedCardTitle.question),
        row.intro,
        row.questions.length === 1
          ? row.questions[0]!.text
          : row.questions.map((question, index) => `${index + 1}. ${question.text}`).join('\n'),
      ])
    case 'feed.result': {
      const approval = row.next === 'awaiting_approval'
      const open = row.next === 'awaiting_user'
      return block([
        agent(
          approval ? feedCardTitle.approval : open ? feedCardTitle.answer : feedCardTitle.result,
        ),
        row.message,
        sentences([
          approval ? feedApprovalSiteText[row.site] : feedDoneSiteText[row.site],
          open || !row.filesChanged ? null : feedFilesChangedText(row.filesChanged),
        ]),
        objectList(row.objects, feedObjectText.result),
      ])
    }
    case 'feed.failure':
      return block([
        agent(feedCardTitle.failure),
        sentences([
          feedFailureTextOf(row.code, withSite),
          feedEndedSiteText[row.site],
          feedCreditsSentence(row.credits),
          row.next === 'awaiting_approval' ? feedFailureKeptText : null,
          row.next === 'awaiting_user' ? feedFailureOpenText : null,
        ]),
        objectList(row.objects, feedObjectText.ended),
      ])
    case 'feed.cancelled':
      return block([
        agent(feedCardTitle.cancelled),
        sentences([
          feedCancelledSentence(row.by),
          feedEndedSiteText[row.site],
          feedCreditsSentence(row.credits),
          row.by === 'queue_timeout' ? FEED_QUEUE_TIMEOUT_CLOSING : null,
        ]),
        objectList(row.objects, feedObjectText.ended),
      ])
    case 'feed.candidate': {
      const changed = row.files.added + row.files.modified + row.files.deleted
      const bump = row.bump ? ` (${feedVersionBumpLabel[row.bump].toLocaleLowerCase('ru')})` : ''
      const counts = [
        changed > 0 ? feedFilesChangedText(changed) : null,
        row.media > 0 ? feedMediaAddedText(row.media) : null,
        row.records > 0 ? feedRecordsChangedText(row.records) : null,
      ].filter((line) => line !== null)
      return block([
        agent(feedCandidateText.title),
        `${feedCandidateVersionText(row.version)}${bump}.`,
        counts.map((line) => `- ${line}`).join('\n'),
      ])
    }
    case 'feed.decision':
      return press(row, feedDecisionText(row.version))
    case 'feed.release':
      return block([
        agent(feedReleaseTitle[row.outcome]),
        sentences([
          feedReleaseText(row.outcome, row.version),
          row.reason === null ? null : feedReleaseReasonText[row.reason],
          ...feedReleaseKeptText(row.kept),
          feedCreditsSentence(row.credits),
        ]),
      ])
    case 'feed.undo':
      if (row.stage === 'confirmed') return press(row, feedUndoConfirmedText(row.undoneVersion))
      return block([
        agent(feedUndoTitle[row.stage]),
        sentences([
          feedUndoText(row.stage, {
            undone: row.undoneVersion,
            version: row.version,
            returnsTo: row.returnsTo,
          }),
          row.reason === null ? null : feedUndoReasonText(row.reason),
          row.stage === 'installed' ? feedUndoKeptText(row.records.kept) : null,
        ]),
      ])
    case 'feed.update':
      return block([
        agent(feedUpdateTitle[row.outcome]),
        feedUpdateText(row.outcome, row.conflicts),
      ])
    case 'feed.screenshot':
      return block([agent(feedExportText.screenshot(row.number))])
    case 'newer':
      return feedRowText.newer
    case 'unreadable':
      return feedRowText.unreadable
    case 'feed.step':
    case 'skipped':
      return null
  }
}

/** The chat as a Markdown file: its name, then its rows in their order. */
export function feedMarkdown(chat: {
  title: string | null
  rows: readonly FeedItem[]
  /** The chat has a project: a chat without one speaks of no site. */
  withSite: boolean
}): string {
  const name = (chat.title ?? '').replace(/\s+/g, ' ').trim()
  const blocks = chat.rows.flatMap((row) => rowBlock(row, chat.withSite) ?? [])
  return `${[`# ${name === '' ? feedExportText.untitled : name}`, ...blocks].join('\n\n---\n\n')}\n`
}

const FILE_NAME_LENGTH = 80

/** The name of the file: the name of the chat, without what file systems refuse. */
export function feedFileName(title: string | null): string {
  const clean = (title ?? '')
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
  const name = Array.from(clean).slice(0, FILE_NAME_LENGTH).join('').trim()
  return `${name === '' ? feedExportText.untitled : name}.md`
}
