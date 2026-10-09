/** The form of a Russian noun that goes with the number: 1 правка, 2 правки, 5 правок. */
export function plural(count: number, one: string, few: string, many: string): string {
  const lastTwo = count % 100
  if (lastTwo >= 11 && lastTwo <= 14) return many
  if (count % 10 === 1) return one
  if (count % 10 >= 2 && count % 10 <= 4) return few
  return many
}
