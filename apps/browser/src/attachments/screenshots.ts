import { randomUUID } from 'node:crypto'

import { browserScreenshotLimits, browserTaskError, browserTaskScreenshotKey } from '@repo/domain'

import type { BrowserWorkerStore } from '../store/worker-store.ts'
import type { InboxStorage } from './attachments.ts'

/**
 * The snapshots the agent takes for the client (`web_screenshot`, owner's request of 26.10.2026):
 * the JPEG into the inbox under its task, then the row of the dialog that shows it — in this
 * order, so a row never names an image that is not there. The model gets none of it (Б20): the
 * tool answers only the number. A task keeps at most `browserScreenshotLimits.perTask`.
 */
export class TaskScreenshots {
  readonly #store: Pick<BrowserWorkerStore, 'screenshotCount' | 'recordScreenshot'>
  readonly #inbox: Pick<InboxStorage, 'put'>
  readonly #newId: () => string

  constructor(
    store: Pick<BrowserWorkerStore, 'screenshotCount' | 'recordScreenshot'>,
    inbox: Pick<InboxStorage, 'put'>,
    newId: () => string = randomUUID,
  ) {
    this.#store = store
    this.#inbox = inbox
    this.#newId = newId
  }

  async save(input: {
    taskId: string
    sessionId: string
    bytes: Uint8Array
    width: number
    height: number
  }): Promise<{ number: number }> {
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > browserScreenshotLimits.bytes)
      throw browserTaskError('BROWSER_ACTION_FAILED')
    // Checked before a byte is stored; the agent's actions of a task run one at a time.
    if ((await this.#store.screenshotCount(input.taskId)) >= browserScreenshotLimits.perTask)
      throw browserTaskError('BROWSER_ACTION_DENIED')
    const screenshotId = this.#newId()
    await this.#inbox.put(
      'inbox',
      browserTaskScreenshotKey(input.taskId, screenshotId),
      input.bytes,
      {
        contentType: 'image/jpeg',
        sizeBytes: input.bytes.byteLength,
      },
    )
    const number = await this.#store.recordScreenshot({
      taskId: input.taskId,
      sessionId: input.sessionId,
      screenshotId,
      width: input.width,
      height: input.height,
    })
    if (number === null) throw browserTaskError('BROWSER_SESSION_UNAVAILABLE')
    return { number }
  }
}
