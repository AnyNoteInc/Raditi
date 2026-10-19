/** The form of a Russian noun that goes with the number: 1 кредит, 2 кредита, 5 кредитов. */
export function pluralRu(count: number, one: string, few: string, many: string): string {
  const whole = Math.abs(Math.trunc(count))
  const lastTwo = whole % 100
  if (lastTwo >= 11 && lastTwo <= 14) return many
  const last = whole % 10
  if (last === 1) return one
  if (last >= 2 && last <= 4) return few
  return many
}
