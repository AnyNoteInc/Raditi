import type { StackGeneration, StackSupport } from '@repo/domain'

// What the platform does with a site of Joomla (docs/plan/62-site-stacks.md, Т1, Т3, Т4, Т18, Т27;
// docs/plan/62-slices/e3.md, Э3.2). Not in the registry yet: the adapter joins it whole in Э3.7,
// because a stack with open files must answer every method (the contract of Э2.3).

/**
 * The branches of Joomla. The first PHP of each is the table of the first choice (Т18), the rest is
 * the order to try (docs/research/2026-11-site-stacks/joomla.md, §11.2), only versions of the images
 * (Т19). `j30` is a branch of the second wave (`not_yet`, Т27): it names PHP only because the
 * contract wants every row to.
 */
export const joomlaGenerations: readonly StackGeneration[] = [
  { id: 'j30', from: '3.0', to: '3.8.99', php: ['7.4'], files: 'off', browser: false, ended: true },
  {
    id: 'j3',
    from: '3.9',
    to: '3.99',
    php: ['7.4', '7.3', '8.0'],
    files: 'dev',
    browser: true,
    ended: true,
  },
  {
    id: 'j4',
    from: '4.0',
    to: '4.99',
    php: ['8.1', '8.2', '8.0', '7.4'],
    files: 'dev',
    browser: true,
    ended: true,
  },
  {
    id: 'j5',
    from: '5.0',
    to: '5.99',
    php: ['8.3', '8.2', '8.1'],
    files: 'dev',
    browser: true,
    ended: false,
  },
  {
    id: 'j6',
    from: '6.0',
    to: '6.99',
    php: ['8.3', '8.4', '8.5'],
    files: 'dev',
    browser: true,
    ended: false,
  },
]

/**
 * `dev` is the working value of the stage: the condition of §5.5 is proved by the end of Э3.14, and a
 * closed stack would not pass `project.create` of the stand. The panel opens in Э8.
 */
export const joomlaSupport: StackSupport = {
  files: 'dev',
  browser: 'off',
  generations: joomlaGenerations,
  refuseBelow: '3.0',
  releaseNeedsChecks: true,
  unknownVersion: 'closed',
}
