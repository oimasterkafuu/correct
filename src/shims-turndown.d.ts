declare module 'turndown' {
  interface TurndownRule {
    filter:
      | string
      | string[]
      | ((node: HTMLElement, options: Record<string, unknown>) => boolean)
    replacement: (content: string, node: HTMLElement, options: Record<string, unknown>) => string
  }

  export default class TurndownService {
    constructor(options?: Record<string, unknown>)
    use(plugin: unknown): void
    addRule(key: string, rule: TurndownRule): void
    turndown(input: string | HTMLElement): string
  }
}

declare module 'turndown-plugin-gfm' {
  export const gfm: unknown
}
