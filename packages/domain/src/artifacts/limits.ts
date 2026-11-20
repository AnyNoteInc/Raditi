/**
 * The bounds of artifacts (docs/plan/88-artifacts.md, Ар52, §7.2, §7.12). Constants, not tariff
 * settings: the agent's tools, core, the cabinet and the renderer read the same numbers.
 */

const KiB = 1024
const MiB = 1024 * KiB
const GiB = 1024 * MiB

export const artifactLimits = Object.freeze({
  /** Blocks, versions, files and copies of one workspace together; without a tariff — 200 MiB. */
  workspaceBytes: GiB,
  workspaceBytesWithoutTariff: 200 * MiB,
  /** Artifacts of a workspace, the trash not counted. */
  workspaceArtifacts: 1000,
  /** Blocks of one artifact; a table counts its rows against `tableRows` instead. */
  blocks: 200,
  /** One block: its content in bytes of UTF-8 (a frame's part — with the ids the server adds). */
  blockBytes: 32 * KiB,
  /** One batch of operations: its JSON in bytes, and its JSON values (keys not counted). */
  batchJsonBytes: 90 * KiB,
  batchJsonNodes: 4000,
  /** Operations of one batch; the `cells` of a table in the cabinet do not count (§7.2). */
  batchOps: 50,
  /** The checked text of one artifact. */
  artifactBytes: 2 * MiB,
  /** A version (`chat_document_versions.size_bytes`). */
  versionBytes: 2 * MiB,
  /** The files of one artifact, and one file. */
  filesBytes: 50 * MiB,
  fileBytes: 5 * MiB,
  /** Versions kept: the last automatic ones, and the named ones (those named by the agent are automatic). */
  automaticVersions: 50,
  namedVersions: 100,
  versionLabelChars: 60,
  /** The journal of operations of one artifact: whichever comes first. */
  journalDays: 30,
  journalOps: 10_000,
  /** What one turn of the agent may do (Ар21, rule 4). */
  agentWritesPerTurn: 120,
  agentArtifactsPerTurn: 20,
  agentCreatesPerTurn: 10,
  agentTrashPerTurn: 20,
  agentVersionsPerTurn: 10,
  agentImportsPerTurn: 5,
  agentLayoutsPerTurn: 20,
  /** Artifacts of other people one turn reads. */
  foreignReadsPerTurn: 20,
  /** `artifact_read`: the outline by pages, the blocks by parts. */
  outlinePageBlocks: 200,
  readPartBytes: 48 * KiB,
  /** `artifact_list`: rows of one answer. */
  listRows: 50,
  /** `changedSinceYourRead`: the ids an answer names before `more`. */
  changedIdsShown: 50,
  /** Imports from the outbox (`artifact_import`). */
  importBytes: 2 * MiB,
  /** Leases: of a person while typing, and of the agent by `artifact_claim`. */
  humanLeaseSeconds: 30,
  /** Artifacts one message of the client may name with `@artifact:<id>` (Ар47). */
  mentionsPerMessage: 10,
  claimSeconds: 120,
  /** How often core checks the agent's writes, as the sections of plan 74. */
  checkIntervalMs: 1500,
  /** Manual edits are glued into one version within this window. */
  versionGlueMinutes: 5,
  /** Links and recipients of one artifact. */
  linksPerArtifact: 10,
  recipientsPerArtifact: 50,
  /** Invitations: from one user a day, and to one artifact. */
  invitesPerUserDay: 50,
  invitesPerArtifact: 10,
  /** Opening a link from one address: 30 in 10 minutes. */
  linkOpensPerWindow: 30,
  linkOpenWindowMinutes: 10,
  /** Manual edits a second of one user. */
  manualEditsPerSecond: 10,
  /** Comments of an artifact, and one comment. */
  comments: 2000,
  commentChars: 2000,
  /** The agent's answers in threads, an hour, of one artifact. */
  agentRepliesPerHour: 60,
  /** Rows of a table, under `artifactBytes` too (a row longer than ~420 bytes hits the bytes first). */
  tableRows: 5000,
  /** Live frames on a canvas: only in view and at a scale of 30 % and more (spike 6). */
  liveFrames: 4,
  liveFrameMinScale: 0.3,
  /** Open tabs of artifacts and files beside a chat (Ар44). */
  openTabs: 8,
  /** Lines of `<project-artifacts>` in the instructions of a pass (Ар26). */
  projectArtifactLines: 30,
  /** Days in the trash. */
  trashDays: 30,
  /** A link's own terms besides «без срока» (Ар33). */
  linkTermsDays: [7, 30] as readonly number[],
  /** A link's token in bytes before encoding. */
  linkTokenBytes: 32,
  /** A cookie of the token without a session (Ар33). */
  shareCookieMinutes: 60,
  /** Hidden keeping of the deleted content of shared artifacts, and the journal of facts (Ар56). */
  hiddenKeepMonths: 6,
  factsJournalYears: 3,
})

/** The renderer of frames and diagrams in `apps/browser` (§7.12, spikes 3 and 7). */
export const artifactRenderLimits = Object.freeze({
  loadMs: 3000,
  /** The responsiveness probe until the clock is frozen; two probes without an answer stop it. */
  probeIntervalMs: 500,
  probesMissedToStop: 2,
  settleMs: 1000,
  scrollPassMs: 2500,
  scrollPassPx: 16_000,
  probeMs: 5000,
  pngMaxCssPx: 16_000,
  pdfMaxPages: 30,
  thumbnailWidths: [480, 195] as readonly number[],
  /** One width with every output, and one call of `artifact_layout`. */
  widthMs: 30_000,
  layoutCallMs: 20_000,
  /** Calls of `artifact_layout` a turn (§7.5). */
  layoutsPerTurn: 20,
  layoutReportChars: 1500,
  /** Quotes of the frame's text the report may carry. */
  layoutQuoteChars: 32,
  viewportWidths: { desktop: 1440, phone: 390 },
  viewportHeights: { desktop: 900, phone: 844 },
  v8HeapMb: 512,
  rendersPerContainer: 2,
  /** A render container: 1 CPU, memory, shm; recreated after 200 renders or 30 minutes. */
  containerCpus: 1,
  containerMemoryMiB: 1536,
  containerShmMiB: 256,
  containerRenders: 200,
  containerMinutes: 30,
  /** `artifact_render` for the helper `look`: checks a turn, pictures a check, strips of JPEG. */
  looksPerTurn: 3,
  picturesPerLook: 4,
  stripPx: 2000,
  /** A diagram: text and edges counted by the platform before the render, the render, the SVG. */
  diagramChars: 50_000,
  diagramEdges: 200,
  diagramRenderMs: 10_000,
  diagramSvgBytes: 512 * KiB,
})
