import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import { vkActionPayloadSchema, vkJobNames, vkNotifyPayloadSchema } from '@repo/domain'
import { errorMessage, throttledLogger } from '@repo/observability'
import { UnrecoverableError, type Job } from 'bullmq'

import type { VkActions } from './vk-actions.ts'
import type { VkNotify } from './vk-notify.ts'
import { VK_ACTIONS, VK_NOTIFY, VK_QUEUE } from './vk.tokens.ts'

/**
 * Works the queue `vk` (docs/plan/99-vk-community.md, §3.3): a press of «Опубликовать» on a card of
 * VK, and the notices of new comments (slice 99.6). One attempt (ВК9): a call that went out and did not answer is `lost`, never sent twice. Job
 * data holds the id of the row only; logs carry the job name and id, never a key or a text.
 */
@Processor(VK_QUEUE, { concurrency: 2 })
export class VkProcessor extends WorkerHost {
  readonly #logger = new Logger(VkProcessor.name)
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(
    @Inject(VK_ACTIONS) private readonly actions: Pick<VkActions, 'run'>,
    @Inject(VK_NOTIFY) private readonly notify: Pick<VkNotify, 'run'>,
  ) {
    super()
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case vkJobNames.action: {
        const payload = vkActionPayloadSchema.safeParse(job.data)
        if (!payload.success) throw new UnrecoverableError('Invalid vk.action payload')
        return this.actions.run(payload.data.actionId)
      }
      // A new comment in a community (slice 99.6): one notice to one owner or admin.
      case vkJobNames.notify: {
        const payload = vkNotifyPayloadSchema.safeParse(job.data)
        if (!payload.success) throw new UnrecoverableError('Invalid vk.notify payload')
        return this.notify.run(payload.data)
      }
      default:
        throw new UnrecoverableError(`Unknown job ${job.name}`)
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    this.#warn(`vk_job_failed name=${job?.name ?? '?'} id=${job?.id ?? '?'}`, errorMessage(error))
  }
}
