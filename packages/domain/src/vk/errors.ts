import { DomainError } from '../errors.ts'

// The refusals of VK (docs/plan/99-vk-community.md). The English message is for the logs and the
// agent; the client reads the Russian text of the code (`vkRefusalTexts`). Nothing of VK's own
// answer — its words may carry the request — goes into a message.

export const vkRefusalCodes = [
  'VK_KEY_INVALID',
  'VK_KEY_NO_WALL',
  'VK_ACCESS_DENIED',
  'VK_RATE_LIMITED',
  'VK_POST_REFUSED',
  'VK_NOT_FOUND',
  'VK_UNREACHABLE',
  'VK_FAILED',
  'VK_COMMUNITY_NOT_FOUND',
  'VK_COMMUNITY_LIMIT',
  'VK_READ_UNAVAILABLE',
  'VK_COMMUNITY_CLOSED',
  'VK_PROPOSAL_LIMIT',
  'VK_PUBLICATION_LIMIT',
  'VK_PUBLISH_AT_PASSED',
  'VK_ALREADY_PUBLISHED',
  'VK_CONFIRM_INVALID',
  'VK_CONFIRM_EXPIRED',
] as const
export type VkRefusalCode = (typeof vkRefusalCodes)[number]

const refusal = (code: VkRefusalCode, message: string, httpStatus: number): DomainError =>
  new DomainError(code, message, httpStatus)

/** VK refused the key: wrong, revoked, or the community is gone (VK 5, 27). */
export const vkKeyInvalid = (): DomainError =>
  refusal('VK_KEY_INVALID', 'VK refused the key of the community', 409)
/** The key has no right «Стена» (groups.getTokenPermissions). */
export const vkKeyNoWall = (): DomainError =>
  refusal('VK_KEY_NO_WALL', 'The key of the community has no access to the wall', 409)
/** VK refused the method with this key (VK 7, 15, 203). */
export const vkAccessDenied = (): DomainError =>
  refusal('VK_ACCESS_DENIED', 'VK refused access', 403)
/** Too many requests (VK 6, 9, 29): later. */
export const vkRateLimited = (): DomainError =>
  refusal('VK_RATE_LIMITED', 'VK asks to wait before the next request', 429)
/** VK refused the post itself: its limits of posts, advertising, the wall (VK 214, 219, 220, 222, 224). */
export const vkPostRefused = (): DomainError =>
  refusal('VK_POST_REFUSED', 'VK refused to publish', 409)
/** A post or a comment that is not there (VK 100 on an id, 212). */
export const vkNotFound = (): DomainError =>
  refusal('VK_NOT_FOUND', 'The post or the comment is not found in VK', 404)
/** No answer of VK: the network, a timeout, an answer that is not VK's. */
export const vkUnreachable = (): DomainError => refusal('VK_UNREACHABLE', 'VK did not answer', 503)
/** Any other error of VK. */
export const vkFailed = (): DomainError => refusal('VK_FAILED', 'VK answered with an error', 502)

export const vkCommunityNotFound = (): DomainError =>
  refusal('VK_COMMUNITY_NOT_FOUND', 'No such connected community', 404)
export const vkCommunityLimit = (): DomainError =>
  refusal('VK_COMMUNITY_LIMIT', 'The workspace has connected the most communities', 409)
/** The service key of the platform is not in Vault: walls are not read now (ВК4). */
export const vkReadUnavailable = (): DomainError =>
  refusal('VK_READ_UNAVAILABLE', 'Reading VK walls is not configured', 503)
/** A closed community: its wall is not read by the service key (ВК4). */
export const vkCommunityClosed = (): DomainError =>
  refusal('VK_COMMUNITY_CLOSED', 'The community is closed: its wall is not read', 409)
export const vkProposalLimit = (): DomainError =>
  refusal('VK_PROPOSAL_LIMIT', 'This turn has proposed the most posts and replies', 409)
export const vkPublicationLimit = (): DomainError =>
  refusal('VK_PUBLICATION_LIMIT', 'The workspace has published the most for a day', 409)
/** The time of a delayed post is too close or has passed: VK takes only a time ahead. */
export const vkPublishAtPassed = (): DomainError =>
  refusal('VK_PUBLISH_AT_PASSED', 'The time of the delayed post has passed', 409)
/** The card was pressed already: one publication a proposal. */
export const vkAlreadyPublished = (): DomainError =>
  refusal('VK_ALREADY_PUBLISHED', 'This proposal was published already', 409)

/** What the client reads for each code: «вы», no jargon. */
export const vkRefusalTexts: Readonly<Record<VkRefusalCode, string>> = Object.freeze({
  VK_KEY_INVALID:
    'ВКонтакте не принимает ключ сообщества. Создайте новый ключ в разделе «Работа с API» и подключите группу заново',
  VK_KEY_NO_WALL:
    'У ключа нет доступа к стене. Создайте ключ с правом «Стена» в разделе «Работа с API»',
  VK_ACCESS_DENIED: 'ВКонтакте не дал доступа. Проверьте права ключа сообщества',
  VK_RATE_LIMITED: 'ВКонтакте просит подождать. Попробуйте через минуту',
  VK_POST_REFUSED:
    'ВКонтакте не принял запись: возможно, исчерпан лимит записей за сутки или стена закрыта',
  VK_NOT_FOUND: 'Запись или комментарий не найдены — возможно, их удалили',
  VK_UNREACHABLE: 'ВКонтакте сейчас не отвечает. Попробуйте позже',
  VK_FAILED: 'ВКонтакте ответил ошибкой. Попробуйте позже',
  VK_COMMUNITY_NOT_FOUND: 'Эта группа не подключена',
  VK_COMMUNITY_LIMIT: 'Подключено максимальное число групп',
  VK_READ_UNAVAILABLE: 'Чтение групп ВКонтакте сейчас недоступно',
  VK_COMMUNITY_CLOSED: 'Группа закрытая: её стену агент не читает',
  VK_PROPOSAL_LIMIT: 'За один ответ агент предлагает не больше трёх публикаций',
  VK_PUBLICATION_LIMIT: 'За сутки опубликовано максимальное число записей',
  VK_PUBLISH_AT_PASSED:
    'Время отложенной записи уже прошло или наступит меньше чем через 10 минут. Попросите агента подготовить запись заново',
  VK_ALREADY_PUBLISHED: 'Эту запись уже отправили на публикацию',
  VK_CONFIRM_INVALID: 'Не удалось подтвердить публикацию. Обновите страницу и нажмите ещё раз',
  VK_CONFIRM_EXPIRED: 'Подтверждение устарело. Нажмите «Опубликовать» ещё раз',
})

/** The Russian text of a refusal of VK, or null for a code of somebody else. */
export function vkRefusalText(code: string): string | null {
  return (vkRefusalTexts as Record<string, string>)[code] ?? null
}

/**
 * The refusal of an error code of VK API (https://dev.vk.com/ru/reference/errors). A code the table
 * does not know is VK_FAILED: never VK's own words.
 */
export function vkErrorOf(code: number): DomainError {
  switch (code) {
    case 5:
    case 27:
    case 28:
      return vkKeyInvalid()
    case 7:
    case 15:
    case 203:
      return vkAccessDenied()
    case 6:
    case 9:
    case 29:
      return vkRateLimited()
    case 214:
    case 219:
    case 220:
    case 222:
    case 224:
      return vkPostRefused()
    case 212:
      return vkNotFound()
    case 10:
      return vkUnreachable()
    default:
      return vkFailed()
  }
}
