/**
 * The platform's own pages on a page host (docs/plan/69-pages.md, Ст9, Ст25, Ст28): the password
 * form, «Документ ещё пишется», the stubs of 404 and 410. Plain HTML with inline styles and no
 * script, served under PAGE_PLATFORM_CSP. Words to the viewer: Russian, «вы» (rule 10).
 */

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const STYLE = `
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F3E7D5;color:#241710;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{box-sizing:border-box;width:min(440px,100% - 32px);background:#FFFCF5;border-radius:16px;padding:32px;box-shadow:0 1px 0 #E1CDB6}
h1{margin:0 0 10px;font-size:22px;line-height:1.3}
p{margin:0 0 14px;color:#695547}
label{display:block;font-size:14px;font-weight:600;margin:6px 0}
input{box-sizing:border-box;width:100%;height:44px;border:1px solid #A1866E;border-radius:10px;padding:0 12px;font:inherit;background:#FFFCF5;color:#241710}
button{margin-top:12px;width:100%;height:44px;border:0;border-radius:10px;background:#241710;color:#FFF8EC;font:inherit;cursor:pointer}
.error{color:#9C3D26}
footer{margin-top:22px;font-size:12px;color:#695547}
a{color:#A63D12}
`

function shell(title: string, body: string, abuseEmail: string | null): string {
  const footer = abuseEmail
    ? `<footer>Пожаловаться на страницу: <a href="mailto:${escape(abuseEmail)}">${escape(abuseEmail)}</a></footer>`
    : ''
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}${footer}</main></body></html>`
}

export type PasswordFormState = 'ask' | 'wrong' | 'too_many' | 'too_long'

const FORM_NOTE: Record<PasswordFormState, string> = {
  ask: '<p>Пароль знает тот, кто прислал вам ссылку.</p>',
  wrong: '<p class="error" role="alert">Пароль не подошёл. Попробуйте ещё раз.</p>',
  too_many:
    '<p class="error" role="alert">Слишком много попыток. Подождите немного и попробуйте снова.</p>',
  too_long:
    '<p class="error" role="alert">Пароль слишком длинный. Проверьте, что вставили только его.</p>',
}

export function passwordFormPage(state: PasswordFormState, abuseEmail: string | null): string {
  return shell(
    'Страница закрыта паролем',
    `<h1>Страница закрыта паролем</h1>${FORM_NOTE[state]}<form method="post" action="/"><label for="password">Пароль</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Открыть</button></form>`,
    abuseEmail,
  )
}

export function writingPage(abuseEmail: string | null): string {
  return shell(
    'Документ ещё пишется',
    '<h1>Документ ещё пишется</h1><p>Загляните немного позже: как только появится первая готовая версия, она откроется по этой ссылке.</p>',
    abuseEmail,
  )
}

export function takenDownPage(abuseEmail: string | null): string {
  return shell(
    'Страница снята с публикации',
    '<h1>Страница снята с публикации</h1><p>Если она вам нужна, напишите тому, кто прислал ссылку.</p>',
    abuseEmail,
  )
}

export function notFoundPage(abuseEmail: string | null): string {
  return shell(
    'Страница не найдена',
    '<h1>Страница не найдена</h1><p>Проверьте ссылку: в ней могла потеряться буква.</p>',
    abuseEmail,
  )
}

export function failedPage(abuseEmail: string | null): string {
  return shell(
    'Не получилось открыть страницу',
    '<h1>Не получилось открыть страницу</h1><p>Попробуйте открыть её ещё раз чуть позже.</p>',
    abuseEmail,
  )
}
