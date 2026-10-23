/**
 * One line of text: no control character of any kind (Unicode Cc), the C1 range with its
 * 8-bit escape sequences included. A refinement, so a tool's JSON schema carries no pattern.
 */
export const isOneLine = (value: string) => !/\p{Cc}/u.test(value)
