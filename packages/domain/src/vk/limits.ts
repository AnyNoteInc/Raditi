// The community of a client in VK (docs/plan/99-vk-community.md): the bounds of what the agent
// reads and proposes. The numbers are Raditi's; the limits of VK itself are refusals it answers.

export const vkLimits = Object.freeze({
  /** Communities one workspace connects. */
  communitiesPerWorkspace: 10,
  /** A key of a community as the form takes it: `vk1.a.` and the rest, printable. */
  tokenChars: 512,
  /** Posts of one `vk_posts` call. */
  postsPerPage: 20,
  /** Comments of one `vk_comments` call. */
  commentsPerPage: 50,
  /** The text of a post or a comment the agent reads: longer is cut with a mark. */
  readTextChars: 2000,
  /** The period of `vk_stats`, in days. */
  statsDays: 90,
  /** Posts `vk_stats` reads at most: four pages of wall.get. */
  statsPosts: 400,
  /** The best posts `vk_stats` names. */
  statsTop: 5,
  /** The text of a proposed post. */
  postChars: 15_000,
  /** The text of a proposed reply to a comment. */
  replyChars: 4000,
  /** Proposals of one turn, posts and replies together (ВК7). */
  proposalsPerTurn: 3,
  /** Publications of one workspace in 24 hours (ВК7). */
  publicationsPerDay: 50,
  /** A delayed post: at least this far ahead, so it is still ahead when the client presses. */
  publishAtMinAheadMs: 10 * 60_000,
  /** A delayed post: at most this far ahead. */
  publishAtMaxAheadMs: 365 * 24 * 60 * 60_000,
})

/**
 * Whether the texts of comments reach the model (docs/plan/99-vk-community.md, ВК17; spec §11): the
 * owner asked the agent to read comments, and their authors' ids never go — a commenter is «reader
 * N» within one answer. «По умолчанию» until the owner and the lawyer answer (plan 99, §8, question
 * 4): false closes the texts, and `vk_comments` gives only how many there are.
 */
export const VK_COMMENT_TEXTS_TO_MODEL = true

/** The version of VK API every call names (ВК12). */
export const VK_API_VERSION = '5.199'
/** The one host of VK API the platform calls. */
export const VK_API_BASE_URL = 'https://api.vk.com/method/'
