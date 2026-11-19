// Conventional Commits in English; semantic-release builds releases from them.
//
// The commits Радити itself writes on the branch of a chat of a project (plan 84, ПР12:
// «Raditi chat <chatId>[, turn <n>]» with the trailer `Raditi-Chat:`) are not linted: they never
// reach main, which gets one squash commit under the title of the pull request, and that title is
// linted by CI as it is.
const raditiChatCommit =
  /^Raditi chat [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:, turn [1-9]\d*)?\n\nRaditi-Chat: /

export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [(message) => raditiChatCommit.test(message)],
}
