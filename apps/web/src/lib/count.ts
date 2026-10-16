/**
 * «300», «2 500»: a count for reading, its digits in groups of three, as an amount of money is
 * grouped. The groups are parted by a plain space, like the rest of a sentence: where the count
 * is shown, nbsp() binds them so that a line never parts the number, and an accessible name
 * keeps the plain space it is looked up by.
 */
export function formatCount(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
