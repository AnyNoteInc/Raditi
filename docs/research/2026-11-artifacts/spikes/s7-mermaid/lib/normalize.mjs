// Safe normalization of a diagram text before any engine sees it:
// - drop a surrounding code fence (```mermaid … ```);
// - turn no-break spaces into plain spaces (Mermaid's text labels show a no-break space as "&nbsp;");
// - drop formatting tags (<b>, <i>, <span …> and the like), keep <br>: with htmlLabels: false Mermaid
//   shows such tags as text. "<<choice>>" and "<|--" are not tags and stay.
// Nothing else is rewritten: a parse error goes back to the agent with the engine's message instead.
const FORMAT_TAGS = /(?<!<)<\/?(?:b|i|u|em|strong|span|font|small|big|sup|sub|mark|code|s|strike|del|ins|p|div)\b[^<>]*>/gi

export function normalizeSource(src, { stripTags = true } = {}) {
  let s = String(src).replace(/\r\n?/g, '\n')
  const fence = s.match(/^\s*(`{3,}|~{3,})[ \t]*(?:mermaid)?[ \t]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/i)
  if (fence) s = fence[2]
  s = s.replace(/[   ]/g, ' ')
  return stripTags ? s.replace(FORMAT_TAGS, '') : s
}
