// No 'use client' here: the server page and the client islands ask the same function.

/**
 * The main action of the landing, wherever it stands: a guest is led to the registration, a
 * visitor with an account to the projects. Written once, so every place calls it by one name.
 */
export const mainAction = (isGuest: boolean) =>
  isGuest
    ? ({ href: '/sign-up', label: 'Зарегистрироваться' } as const)
    : ({ href: '/projects', label: 'Открыть проекты' } as const)
