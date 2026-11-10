/**
 * How long the address of the file lives after the click. A browser starts the save after the
 * click returns — Safari and Firefox read the address then — and an address revoked at once can
 * save nothing or an empty file.
 */
export const REVOKE_AFTER_MS = 10_000

/** Gives the client a text made on the page as a file: the browser saves it, nothing is sent. */
export function downloadText(fileName: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
}
