import type { SiteAdapter, SiteStack } from '@repo/domain'
import { notImplemented } from '@repo/domain'

type BrowserTaskMethods = Pick<
  SiteAdapter,
  | 'browserTaskPolicy'
  | 'browserCheckpointOf'
  | 'browserCommitAction'
  | 'browserVerification'
  | 'browserGuide'
>

/**
 * The methods of a task's browser of a stack whose panel the platform does not open yet
 * (docs/plan/62-site-stacks.md, Т8): Bitrix and the new stacks until Э8. Each throws; no task of
 * such a site reaches them, its `support.browser` is `off`.
 */
export function noBrowserTasks(stack: SiteStack): BrowserTaskMethods {
  const refuse = (): never => {
    throw notImplemented(`Browser tasks on ${stack}`)
  }
  return {
    browserTaskPolicy: refuse,
    browserCheckpointOf: refuse,
    browserCommitAction: refuse,
    browserVerification: refuse,
    browserGuide: refuse,
  }
}
