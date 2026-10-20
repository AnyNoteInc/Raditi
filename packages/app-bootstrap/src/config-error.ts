/** Lists every problem at once; names variables, never their values. `subject` names the app. */
export class ConfigError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[], subject: string) {
    super(`Invalid ${subject} configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}
