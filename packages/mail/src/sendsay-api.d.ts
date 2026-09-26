// sendsay-api ships no type declarations.
declare module 'sendsay-api' {
  export interface SendsayOptions {
    apiUrl?: string
    apiKey?: string
  }

  export default class Sendsay {
    constructor(options?: SendsayOptions)
    request(payload: Record<string, unknown>): Promise<unknown>
  }
}
