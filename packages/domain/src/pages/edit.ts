/**
 * A search and replace in the text of a page (docs/plan/73-pages-sites.md, Дер23): `old` is found
 * once, or every time with `all`. `page_edit` checks it at the call against the text the page
 * shows; core makes it at the end of the turn against the text the page shows then.
 */
export interface PageTextEdit {
  old: string
  new: string
  all?: boolean | undefined
}

/** The text after the edits, or the index of the first one that cannot be made. */
export function editPageText(
  text: string,
  edits: readonly PageTextEdit[],
): { ok: true; text: string } | { ok: false; at: number; found: number } {
  let out = text
  for (const [at, edit] of edits.entries()) {
    const found = out.split(edit.old).length - 1
    if (found === 0 || (found > 1 && !edit.all)) return { ok: false, at, found }
    out = out.split(edit.old).join(edit.new)
  }
  return { ok: true, text: out }
}
