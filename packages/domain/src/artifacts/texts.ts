import { pluralRu } from '../plural.ts'

/**
 * The words of artifacts the client reads (docs/plan/88-artifacts.md, rule 10, Ар5, Ар9, Ар21,
 * Ар31, Ар33, Ар40, Ар54). The names of kinds are `artifactKindSpecs[kind].label`, of roles —
 * `artifactRoleLabels`, of refusals — `artifactRefusalTexts`.
 */
export const artifactTexts = Object.freeze({
  section: 'Артефакты',
  linkAudience: 'Пользователи Радити, у которых есть ссылка',
  frameEditNote: 'В режиме правки скрипты экрана выключены',
  createdByUser: 'Содержимое создал пользователь Радити',
  sharedWithYou: 'С вами поделились',
  newComment: 'Новый комментарий',
  agentReplied: 'Агент ответил на комментарий',
  updated: 'Артефакт обновлён',
  takeBack: 'Забрать правку',
  diverged: 'Разошлись',
  keepMine: 'Оставить мой',
  takeOther: 'Взять другой',
  mergeByHand: 'Совместить вручную',
  agentWriting: 'Пишет агент…',
  acceptNotice: 'Ваше имя увидят владелец и все, у кого есть доступ; почту — владелец',
})

/** Another person's chat is never named: «Агент <Имя>» (Ар21, Ар40). */
export function artifactAgentLabel(personName: string): string {
  const name = personName.trim()
  return name === '' ? 'Агент' : `Агент ${name}`
}

/** «<Имя> изменил(а) «…»» of a notification and of «Все изменения» (Ар21, Ар54). */
export function artifactChangedBy(personName: string, title: string): string {
  return `${personName.trim()} изменил(а) «${title}»`
}

/** «Сохранено · версия N» of the head of an artifact (Ар44). */
export function artifactSavedLine(version: number): string {
  return `Сохранено · версия ${version}`
}

/** «Ещё N» of the tabs that do not fit (Ар44). */
export function artifactMoreTabs(count: number): string {
  return `Ещё ${count}`
}

/** «N изменений других» the agent's answer turns into a line of «Ход работы». */
export function artifactChangedByOthers(count: number): string {
  return `${count} ${pluralRu(count, 'блок изменили', 'блока изменили', 'блоков изменили')} другие`
}
