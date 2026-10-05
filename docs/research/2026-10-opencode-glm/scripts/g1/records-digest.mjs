// What the fake saw of a run, without the bodies: how many model requests, when, how large, what each
// declared and how it was answered — and what the tools had answered, as the model was told. The fake's
// full records are too large for the repository (a request repeats the whole conversation); this is the
// part of them the report's statements about request sizes and tool results rest on.

/**
 * `{ requests: [{ n, ms, bodyBytes, fields, tools, system, messages, answer }], toolResults: [text] }`;
 * `fields` and `messages` are one line each: a digest is read by people.
 */
export function digestRecords(result) {
  const llm = (result.records ?? []).filter((record) => record.kind === 'llm')
  const requests = llm.map((record) => {
    const summary = record.request.summary ?? {}
    const response = record.response ?? {}
    return {
      n: record.n,
      ms: record.ms,
      bodyBytes: record.request.bodyBytes,
      fields: (summary.fields ?? []).join(','),
      tools: summary.tools?.length ?? 0,
      system: String(summary.systemHead ?? '').slice(0, 80),
      messages: (summary.messages ?? []).join(' '),
      answer: response.capped
        ? `cap of the stand, ${response.status}`
        : `${response.kind} ${response.status}`,
    }
  })
  // The request that carried the most tool results: the last one of an ordinary turn.
  const toolMessages = (record) =>
    (record.request.body?.messages ?? []).filter((message) => message.role === 'tool')
  const fullest = llm.reduce(
    (best, record) => (toolMessages(record).length >= toolMessages(best).length ? record : best),
    llm[0],
  )
  const toolResults = fullest
    ? toolMessages(fullest).map((message) =>
        (typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content)
        ).slice(0, 200),
      )
    : []
  return { requests, toolResults }
}
