/**
 * Request header with the path and query of the page being rendered. The proxy sets it
 * (overwriting anything the client sent): layouts do not know their URL otherwise, and the
 * protected layout needs it for `/sign-in?next=…`. Treat it as untrusted input all the same.
 */
export const REQUEST_PATH_HEADER = 'x-raditi-path'
