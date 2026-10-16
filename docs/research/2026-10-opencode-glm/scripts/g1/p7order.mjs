// Point 7 of G1, added by the review: does the order of the keys of `permission.external_directory` matter?
// The same seven calls as the inbox runs of p7.mjs, with the two rules in both orders. The report's
// statement "the last matching rule wins" rests on this run.
import { inboxFiles, inboxSteps, run } from './p7.mjs'

const rules = (entries) => (draft) =>
  void (draft.permission.external_directory = Object.fromEntries(entries))

export async function p7order(stand) {
  return {
    order: [
      await run(stand, 'order-deny-then-allow', {
        change: rules([
          ['*', 'deny'],
          ['/workspace/inbox/*', 'allow'],
        ]),
        steps: inboxSteps,
        files: inboxFiles,
      }),
      await run(stand, 'order-allow-then-deny', {
        change: rules([
          ['/workspace/inbox/*', 'allow'],
          ['*', 'deny'],
        ]),
        steps: inboxSteps,
        files: inboxFiles,
      }),
    ],
  }
}
