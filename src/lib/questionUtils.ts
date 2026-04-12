const INLINE_BLANK_PATTERN =
  /（[^（）]*）|(?<!\])\([^()]*\)|【[^【】]*】|(?<!!)\[[^\]]*\](?!\()|_{2,}|＿{2,}|(?<=\s)▲(?=\s)/g
const LEGACY_BLANK_PATTERN = /\[\[BLANK_(\d+)\]\]/g
const LEGACY_CHOICE_TOKEN = '[[CHOICE_SLOT]]'
const INLINE_TOKEN_REGEXP = /\[\[INLINE_BLANK_(\d+)\]\]/g
const AREA_TOKEN_REGEXP = /\[\[AREA_BLANK_(\d+)\]\]/g
const AREA_PLACEHOLDER = '__AREA_BLANK_PLACEHOLDER__'

export const INLINE_BLANK_PREFIX = '[[INLINE_BLANK_'
export const AREA_BLANK_PREFIX = '[[AREA_BLANK_'
export const INLINE_BLANK_TOKEN_REGEX = INLINE_TOKEN_REGEXP
export const AREA_BLANK_TOKEN_REGEX = AREA_TOKEN_REGEXP

function inlineBlankToken(index: number): string {
  return `${INLINE_BLANK_PREFIX}${index}]]`
}

function areaBlankToken(index: number): string {
  return `${AREA_BLANK_PREFIX}${index}]]`
}

export function detectInlineBlankCount(stem: string): number {
  return [...stem.matchAll(INLINE_BLANK_PATTERN)].length
}

export function normalizeChoiceStem(stem: string): {
  normalizedStem: string
  replaced: boolean
  appended: boolean
  hadMultiple: boolean
} {
  const matches = [...stem.matchAll(INLINE_BLANK_PATTERN)]
  if (matches.length === 0) {
    return {
      normalizedStem: `${stem.trimEnd()} ${inlineBlankToken(1)}`.trim(),
      replaced: false,
      appended: true,
      hadMultiple: false,
    }
  }

  const lastMatch = matches[matches.length - 1]
  const start = lastMatch.index ?? 0
  const end = start + lastMatch[0].length

  return {
    normalizedStem: `${stem.slice(0, start)}${inlineBlankToken(1)}${stem.slice(end)}`,
    replaced: true,
    appended: false,
    hadMultiple: matches.length > 1,
  }
}

export function normalizeBlankStem(stem: string): {
  normalizedStem: string
  blankCount: number
  appended: boolean
} {
  const matches = [...stem.matchAll(INLINE_BLANK_PATTERN)]
  if (matches.length === 0) {
    return {
      normalizedStem: `${stem.trimEnd()} ${inlineBlankToken(1)}`.trim(),
      blankCount: 1,
      appended: true,
    }
  }

  let index = 0
  return {
    normalizedStem: stem.replace(INLINE_BLANK_PATTERN, () => {
      index += 1
      return inlineBlankToken(index)
    }),
    blankCount: matches.length,
    appended: false,
  }
}

export function detectSubjectiveBlankCount(stem: string): number {
  return normalizeSubjectiveStem(stem).blankCount
}

export function normalizeSubjectiveStem(stem: string): {
  normalizedStem: string
  blankCount: number
  appendedTrailing: boolean
} {
  const lines = stem.split('\n')
  const output: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmedLine = line.trim()

    if (trimmedLine === '▲' || /^\[\[AREA_BLANK_\d+\]\]$/.test(trimmedLine)) {
      output.push(AREA_PLACEHOLDER)
      continue
    }

    const lineWithAreaTokens = line.replace(AREA_TOKEN_REGEXP, AREA_PLACEHOLDER)

    if (lineWithAreaTokens.trim() === '') {
      let j = i
      while (j < lines.length && lines[j].trim() === '') {
        j += 1
      }

      const emptyCount = j - i
      if (emptyCount >= 2) {
        output.push(AREA_PLACEHOLDER)
        i = j - 1
        continue
      }
    }

    output.push(lineWithAreaTokens)
  }

  let normalizedStem = output.join('\n')
  const endsWithBlank = normalizedStem.trimEnd().endsWith(AREA_PLACEHOLDER)
  let appendedTrailing = false
  if (!endsWithBlank) {
    appendedTrailing = true
    const base = normalizedStem.trimEnd()
    normalizedStem = base.length > 0 ? `${base}\n${AREA_PLACEHOLDER}` : AREA_PLACEHOLDER
  }

  let areaIndex = 0
  normalizedStem = normalizedStem.replace(new RegExp(AREA_PLACEHOLDER, 'g'), () => {
    areaIndex += 1
    return areaBlankToken(areaIndex)
  })

  return {
    normalizedStem,
    blankCount: areaIndex,
    appendedTrailing,
  }
}

export function countInlineTokens(normalizedStem: string): number {
  return [...normalizedStem.matchAll(INLINE_TOKEN_REGEXP)].length
}

export function countAreaTokens(normalizedStem: string): number {
  return [...normalizedStem.matchAll(AREA_TOKEN_REGEXP)].length
}

export function migrateStemTokens(stem: string): string {
  return stem
    .replaceAll(LEGACY_CHOICE_TOKEN, inlineBlankToken(1))
    .replace(LEGACY_BLANK_PATTERN, (_raw, index: string) => inlineBlankToken(Number(index)))
}

export function getTodayDateKey(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function alphaLabel(index: number): string {
  return String.fromCharCode(65 + index)
}

export function fromLocalStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function toLocalStorage<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value))
}

export function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
