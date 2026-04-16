import { pangu } from 'pangu'

export const NO_PANGU_MARKER = '<!--no-pangu-->'

const FENCED_CODE_BLOCK_REGEX = /```[\s\S]*?```/g
const INLINE_CODE_REGEX = /`[^`\n]+`/g
const DISPLAY_MATH_REGEX = /\$\$[\s\S]*?\$\$/g
const INLINE_MATH_REGEX = /(^|[^$])(\$[^$\n]+?\$)(?!\$)/g
const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*]\(([^)\s]+)(\s+"[^"]*")?\)/g
const MARKDOWN_LINK_REGEX = /(?<!!)\[[^\]]+]\(([^)\s]+)(\s+"[^"]*")?\)/g
const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g
const HTML_TAG_REGEX = /<\/?[A-Za-z][^>]*>/g
const INLINE_BLANK_TOKEN_REGEX = /\[\[INLINE_BLANK_\d+\]\]/g
const AREA_BLANK_TOKEN_REGEX = /\[\[AREA_BLANK_\d+\]\]/g
const PLACEHOLDER_PREFIX = 'PANGUPLACEHOLDERTOKEN'

function normalizeLineEndings(value: string): string {
  return value.replace(/\r/g, '')
}

function buildPlaceholder(index: number): string {
  return `${PLACEHOLDER_PREFIX}${index}END`
}

function protectMatches(
  input: string,
  regex: RegExp,
  protectedTokens: string[],
): string {
  return input.replace(regex, (...args) => {
    const match = args[0] as string
    const index = protectedTokens.push(match) - 1
    return buildPlaceholder(index)
  })
}

function restoreProtectedMatches(input: string, protectedTokens: string[]): string {
  return input.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)END`, 'g'),
    (_full, index: string) => protectedTokens[Number(index)] ?? '',
  )
}

export function hasNoPanguMarker(markdown: string): boolean {
  const normalized = normalizeLineEndings(markdown)
  const firstLine = normalized.split('\n', 1)[0] ?? ''
  return firstLine.trim() === NO_PANGU_MARKER
}

export function stripNoPanguMarker(markdown: string): string {
  const normalized = normalizeLineEndings(markdown)
  if (!hasNoPanguMarker(normalized)) {
    return normalized
  }

  const [, ...restLines] = normalized.split('\n')
  return restLines.join('\n').replace(/^\n+/, '')
}

export function applyPanguSpacing(markdown: string): string {
  const normalized = normalizeLineEndings(markdown)
  if (!normalized.trim()) {
    return normalized
  }

  const protectedTokens: string[] = []
  let working = normalized

  working = protectMatches(working, FENCED_CODE_BLOCK_REGEX, protectedTokens)
  working = protectMatches(working, DISPLAY_MATH_REGEX, protectedTokens)
  working = protectMatches(working, MARKDOWN_IMAGE_REGEX, protectedTokens)
  working = protectMatches(working, MARKDOWN_LINK_REGEX, protectedTokens)
  working = protectMatches(working, HTML_COMMENT_REGEX, protectedTokens)
  working = protectMatches(working, HTML_TAG_REGEX, protectedTokens)
  working = protectMatches(working, INLINE_BLANK_TOKEN_REGEX, protectedTokens)
  working = protectMatches(working, AREA_BLANK_TOKEN_REGEX, protectedTokens)
  working = protectMatches(working, INLINE_CODE_REGEX, protectedTokens)
  working = working.replace(INLINE_MATH_REGEX, (_full, prefix: string, mathToken: string) => {
    const index = protectedTokens.push(mathToken) - 1
    return `${prefix}${buildPlaceholder(index)}`
  })

  const spaced = pangu.spacingText(working)
  return restoreProtectedMatches(spaced, protectedTokens)
    .replace(/([\u3400-\u9fff])\s+(\[\[(?:INLINE|AREA)_BLANK_\d+\]\])/g, '$1$2')
    .replace(/(\[\[(?:INLINE|AREA)_BLANK_\d+\]\])\s+([\u3400-\u9fff])/g, '$1$2')
}

export function prepareMarkdownForSubmission(
  markdown: string,
  options?: { disableAutoSpacing?: boolean },
): string {
  const normalized = normalizeLineEndings(markdown)
  if (options?.disableAutoSpacing) {
    return normalized
  }
  if (hasNoPanguMarker(normalized)) {
    return normalized
  }
  return applyPanguSpacing(normalized)
}
