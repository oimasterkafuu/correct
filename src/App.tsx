import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import katex from 'katex'
import { useLocation, useNavigate } from 'react-router-dom'
import MarkdownEditor from './components/MarkdownEditor'
import MarkdownRenderer from './components/MarkdownRenderer'
import { SUBJECT_MAP, SUBJECTS } from './data/subjects'
import {
  alphaLabel,
  countAreaTokens,
  countInlineTokens,
  detectInlineBlankCount,
  formatDateTime,
  fromLocalStorage,
  getTodayDateKey,
  migrateStemTokens,
  normalizeBlankStem,
  normalizeChoiceStem,
  normalizeSubjectiveStem,
  stripTrailingSlash,
  toLocalStorage,
} from './lib/questionUtils'
import type { AiSettings, ChoiceMode, Question, QuestionType, SubjectKey } from './types'

type CreditFilter = 'all' | 'humanities' | 'science' | 'other'
type TypeFilter = QuestionType | 'all'
type AnalysisTarget = 'choice' | 'blank' | 'subjective'
type PdfExportTarget = 'plain' | 'analysis'

interface DraftState {
  subject: SubjectKey
  type: QuestionType
  stem: string
  choiceMode: ChoiceMode
  optionStyle: 'latin' | 'circle'
  optionCount: number
  options: string[]
  choiceAnswers: number[]
  choiceAnalysis: string
  fillAnswers: string[]
  fillAnalysis: string
  subjectiveAnswers: string[]
  subjectiveAnalysis: string
}

interface ParsedAiResponse {
  analysisMarkdown: string
  generatedAnswers: string[]
  answerReasonable: boolean | null
  reasonabilityComment: string
}

type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
type ChatMessageContent = string | ChatContentPart[]

const QUESTIONS_KEY = 'mistakes.questions.v1'
const LAST_CREATED_SUBJECT_KEY = 'mistakes.last-created-subject.v1'
const AI_SETTINGS_CLOUD_URL = import.meta.env.VITE_AI_SETTINGS_URL?.trim() || '/api/ai-settings'
const AI_SETTINGS_CLOUD_TOKEN = import.meta.env.VITE_AI_SETTINGS_TOKEN?.trim() || ''

const INITIAL_AI_SETTINGS: AiSettings = {
  enabled: true,
  baseUrl: '',
  apiKey: '',
  model: '',
}

const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  choice: '选择题',
  blank: '填空题',
  subjective: '主观题',
}

const CHOICE_MODE_LABEL: Record<ChoiceMode, string> = {
  single: '单选题',
  double: '双选题',
  multiple: '不定项选择题',
}
const CREDIT_FILTER_LABEL: Record<CreditFilter, string> = {
  all: '全部学分',
  humanities: '文科学分',
  science: '理科学分',
  other: '其他学分',
}

const CIRCLE_LABELS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']
const SUBJECT_KEY_SET = new Set<SubjectKey>(SUBJECTS.map((subject) => subject.key))

const HUMANITIES_SUBJECTS = new Set<SubjectKey>(['chinese', 'history', 'politics', 'geography'])
const SCIENCE_SUBJECTS = new Set<SubjectKey>([
  'math',
  'english',
  'physics',
  'chemistry',
  'biology',
])

function getQuestionCreditCategory(subject: SubjectKey): Exclude<CreditFilter, 'all'> {
  if (HUMANITIES_SUBJECTS.has(subject)) {
    return 'humanities'
  }
  if (SCIENCE_SUBJECTS.has(subject)) {
    return 'science'
  }
  return 'other'
}

function isSubjectKey(value: unknown): value is SubjectKey {
  return typeof value === 'string' && SUBJECT_KEY_SET.has(value as SubjectKey)
}

function getLastCreatedSubject(): SubjectKey {
  const saved = fromLocalStorage<string | null>(LAST_CREATED_SUBJECT_KEY, null)
  return isSubjectKey(saved) ? saved : 'math'
}

const INLINE_TOKEN_REGEX = /\[\[INLINE_BLANK_(\d+)\]\]/g
const AREA_TOKEN_REGEX = /\[\[AREA_BLANK_(\d+)\]\]/g
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g
const IMAGE_ID_URL_REGEX = /^image_(\d+)$/
const BASE64_IMAGE_PREFIX_REGEX = /^data:image\/[a-zA-Z0-9.+-]+;base64,/i
const BASE64_IMAGE_URL_REGEX = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/_=-]+$/i
const LONG_BASE64_IMAGE_LENGTH = 1600

function isLongBase64ImageUrl(url: string): boolean {
  return BASE64_IMAGE_PREFIX_REGEX.test(url) && url.length >= LONG_BASE64_IMAGE_LENGTH
}

function isBase64ImageUrl(url: string): boolean {
  return BASE64_IMAGE_URL_REGEX.test(url)
}

function convertDataImageToBlobUrl(dataUrl: string): string | null {
  const matched = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/_=-]+)$/i)
  if (!matched) {
    return null
  }

  try {
    const mimeType = matched[1]
    const binary = atob(matched[2])
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    const blob = new Blob([bytes], { type: mimeType })
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

function convertLongBase64ImagesToIds(
  markdown: string,
  rememberImage: (dataUrl: string) => string,
): string {
  if (!markdown.includes('data:image/') || !markdown.includes('![')) {
    return markdown
  }

  return markdown.replace(MARKDOWN_IMAGE_REGEX, (full, alt: string, url: string, title?: string) => {
    const imageUrl = url.trim()
    if (!isLongBase64ImageUrl(imageUrl)) {
      return full
    }
    const imageId = rememberImage(imageUrl)
    const suffix = typeof title === 'string' ? title : ''
    return `![${alt}](${imageId}${suffix})`
  })
}

function materializeImageIds(markdown: string, imageMemory: Record<string, string>): string {
  if (!markdown.includes('image_') || !markdown.includes('![')) {
    return markdown
  }

  return markdown.replace(MARKDOWN_IMAGE_REGEX, (full, alt: string, url: string, title?: string) => {
    const imageUrl = url.trim()
    if (!IMAGE_ID_URL_REGEX.test(imageUrl)) {
      return full
    }
    const resolved = imageMemory[imageUrl]
    if (!resolved) {
      return full
    }
    const suffix = typeof title === 'string' ? title : ''
    return `![${alt}](${resolved}${suffix})`
  })
}

function resolveImageUrlForAi(url: string, imageMemory: Record<string, string>): string | null {
  const normalizedUrl = url.trim()
  if (!normalizedUrl) {
    return null
  }

  if (IMAGE_ID_URL_REGEX.test(normalizedUrl)) {
    return imageMemory[normalizedUrl] ?? null
  }

  return normalizedUrl
}

function pushTextPart(parts: ChatContentPart[], text: string): void {
  if (!text) {
    return
  }
  const lastPart = parts[parts.length - 1]
  if (lastPart && lastPart.type === 'text') {
    lastPart.text += text
    return
  }
  parts.push({
    type: 'text',
    text,
  })
}

function buildUserMessageContent(prompt: string, imageMemory: Record<string, string>): ChatMessageContent {
  if (!prompt.includes('![') || !prompt.includes('(')) {
    return prompt
  }

  const imageRegex = new RegExp(MARKDOWN_IMAGE_REGEX.source, 'g')
  const parts: ChatContentPart[] = []
  let cursor = 0
  let imageCounter = 1
  let hasResolvedImage = false

  for (const match of prompt.matchAll(imageRegex)) {
    const index = match.index ?? 0
    const full = match[0]
    const alt = (match[1] ?? '').trim()
    const url = match[2] ?? ''
    const resolvedUrl = resolveImageUrlForAi(url, imageMemory)

    pushTextPart(parts, prompt.slice(cursor, index))

    if (!resolvedUrl) {
      pushTextPart(parts, full)
      cursor = index + full.length
      continue
    }

    hasResolvedImage = true
    const altSuffix = alt ? `：${alt}` : ''
    pushTextPart(parts, `[图片${imageCounter}${altSuffix}]`)
    parts.push({
      type: 'image_url',
      image_url: {
        url: resolvedUrl,
      },
    })
    imageCounter += 1
    cursor = index + full.length
  }

  pushTextPart(parts, prompt.slice(cursor))
  return hasResolvedImage ? parts : prompt
}

const createInitialDraft = (): DraftState => ({
  subject: 'math',
  type: 'choice',
  stem: '',
  choiceMode: 'single',
  optionStyle: 'latin',
  optionCount: 4,
  options: Array.from({ length: 8 }, () => ''),
  choiceAnswers: [],
  choiceAnalysis: '',
  fillAnswers: [],
  fillAnalysis: '',
  subjectiveAnswers: [''],
  subjectiveAnalysis: '',
})

function buildDraftFromQuestion(
  question: Question,
  normalizeMarkdownForEdit: (value: string) => string,
): DraftState {
  if (question.type === 'choice') {
    return {
      ...createInitialDraft(),
      subject: question.subject,
      type: 'choice',
      stem: normalizeMarkdownForEdit(question.stem),
      choiceMode: question.choiceMode,
      optionStyle: question.optionStyle,
      optionCount: question.optionCount,
      options: ensureLength(question.options, 8),
      choiceAnswers: sanitizeChoiceAnswers(
        question.choiceMode,
        question.correctAnswers,
        question.optionCount,
      ),
      choiceAnalysis: normalizeMarkdownForEdit(question.analysis),
    }
  }

  if (question.type === 'blank') {
    return {
      ...createInitialDraft(),
      subject: question.subject,
      type: 'blank',
      stem: normalizeMarkdownForEdit(question.stem),
      fillAnswers: ensureLength(question.answers, Math.max(1, question.blankCount)),
      fillAnalysis: normalizeMarkdownForEdit(question.analysis),
    }
  }

  return {
    ...createInitialDraft(),
    subject: question.subject,
    type: 'subjective',
    stem: normalizeMarkdownForEdit(question.stem),
    subjectiveAnswers: ensureLength(question.answers, Math.max(1, question.areaCount)),
    subjectiveAnalysis: normalizeMarkdownForEdit(question.analysis),
  }
}

function parseEditQuestionIdFromPath(pathname: string): string | null {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/'
  const matched = normalizedPath.match(/^\/edit\/([^/]+)$/i)
  if (!matched) {
    return null
  }
  try {
    const decoded = decodeURIComponent(matched[1]).trim()
    return decoded.length > 0 ? decoded : null
  } catch {
    const fallback = matched[1].trim()
    return fallback.length > 0 ? fallback : null
  }
}

function getOptionMarker(index: number, style: 'latin' | 'circle'): string {
  if (style === 'circle') {
    return CIRCLE_LABELS[index] ?? `(${index + 1})`
  }
  return alphaLabel(index)
}

function buildAIEndpoint(baseUrl: string): string {
  const trimmed = stripTrailingSlash(baseUrl.trim())
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed
  }
  return `${trimmed}/chat/completions`
}

function parseAiSettingsFromPayload(payload: unknown): AiSettings | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const root = payload as Record<string, unknown>
  const nestedSettings = root.settings
  const nestedData = root.data
  const candidate =
    nestedSettings && typeof nestedSettings === 'object'
      ? nestedSettings
      : nestedData && typeof nestedData === 'object'
        ? nestedData
        : root

  if (!candidate || typeof candidate !== 'object') {
    return null
  }

  const source = candidate as Record<string, unknown>
  const baseUrl = typeof source.baseUrl === 'string' ? source.baseUrl.trim() : ''
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : ''
  const model = typeof source.model === 'string' ? source.model.trim() : ''
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : true

  return {
    enabled,
    baseUrl,
    apiKey,
    model,
  }
}

function maskSecret(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return '未配置'
  }
  if (trimmed.length <= 8) {
    return '********'
  }
  return `${trimmed.slice(0, 4)}${'*'.repeat(Math.max(4, trimmed.length - 8))}${trimmed.slice(-4)}`
}

function ensureLength(values: string[], count: number): string[] {
  if (count <= values.length) {
    return values
  }
  return [...values, ...Array.from({ length: count - values.length }, () => '')]
}

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

function sanitizeChoiceAnswers(mode: ChoiceMode, values: number[], optionCount: number): number[] {
  const cleaned = uniqueSortedNumbers(values.filter((index) => index >= 0 && index < optionCount))
  if (mode === 'single') {
    return cleaned.length > 0 ? [cleaned[0]] : []
  }
  if (mode === 'double') {
    return cleaned.slice(0, 2)
  }
  return cleaned
}

function validateChoiceAnswers(mode: ChoiceMode, answers: number[]): boolean {
  if (mode === 'single') return answers.length === 1
  if (mode === 'double') return answers.length === 2
  return answers.length >= 1
}

function flattenOptionText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function normalizeMathDelimitersForAnswer(value: string): string {
  return value
    .replace(/\\\[((?:[\s\S]*?))\\\]/g, (_full, expression: string) => `\n$$\n${expression}\n$$\n`)
    .replace(/\\\(((?:[\s\S]*?))\\\)/g, (_full, expression: string) => `$${expression}$`)
}

function renderAnswerHtml(value: string): string {
  const normalized = normalizeMathDelimitersForAnswer(value || '').replace(/\r/g, '')
  const mathRegex = /(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g
  let html = ''
  let cursor = 0

  for (const match of normalized.matchAll(mathRegex)) {
    const index = match.index ?? 0
    const textPart = normalized.slice(cursor, index)
    if (textPart.length > 0) {
      html += escapeHtml(textPart).replace(/\n/g, '<br />')
    }

    const token = match[0]
    const displayMode = token.startsWith('$$')
    const latex = token.slice(displayMode ? 2 : 1, displayMode ? -2 : -1).trim()
    if (latex.length > 0) {
      html += katex.renderToString(latex, {
        throwOnError: false,
        displayMode,
      })
    }

    cursor = index + token.length
  }

  const tail = normalized.slice(cursor)
  if (tail.length > 0) {
    html += escapeHtml(tail).replace(/\n/g, '<br />')
  }

  return html.trim().length > 0 ? html : '&nbsp;'
}

function buildInlineBlankHtml(value: string): string {
  const content = renderAnswerHtml(value || '')
  return `<span class="inline-blank-box"><span class="inline-blank-answer">${content}</span></span>`
}

function buildAreaBlankHtml(value: string): string {
  const content = renderAnswerHtml(value || '')
  return `<div class="area-blank-box"><span class="area-blank-answer">${content}</span></div>`
}

function replaceInlineBlanksWithValues(stem: string, values: string[]): string {
  return stem.replace(INLINE_TOKEN_REGEX, (_raw, index: string) => {
    const value = values[Number(index) - 1] ?? ''
    return buildInlineBlankHtml(value)
  })
}

function replaceAreaBlanksWithValues(stem: string, values: string[]): string {
  const withBlocks = stem.replace(AREA_TOKEN_REGEX, (_raw, index: string) => {
    const value = values[Number(index) - 1] ?? ''
    return `\n\n${buildAreaBlankHtml(value)}\n\n`
  })
  return withBlocks.replace(/\n{3,}/g, '\n\n').trim()
}

function extractJsonCandidate(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }

  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) {
    return raw.slice(first, last + 1)
  }
  return null
}

function normalizeToStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? '').trim())
      .filter((item) => item.length > 0)
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()]
  }
  return []
}

function tryParseJsonObject(candidate: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(candidate) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function countSuspiciousControlChars(value: unknown): number {
  if (typeof value === 'string') {
    let count = 0
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i)
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        count += 1
      }
    }
    return count
  }

  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + countSuspiciousControlChars(item), 0)
  }

  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (total, item) => total + countSuspiciousControlChars(item),
      0,
    )
  }

  return 0
}

function repairJsonStringBackslashes(candidate: string): string {
  let result = ''
  let inString = false
  let i = 0

  while (i < candidate.length) {
    const current = candidate[i]

    if (!inString) {
      result += current
      if (current === '"') {
        inString = true
      }
      i += 1
      continue
    }

    if (current === '"') {
      inString = false
      result += current
      i += 1
      continue
    }

    if (current !== '\\') {
      result += current
      i += 1
      continue
    }

    const next = candidate[i + 1]
    if (next === undefined) {
      result += '\\\\'
      i += 1
      continue
    }

    if (next === 'u') {
      const hex = candidate.slice(i + 2, i + 6)
      if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
        result += `\\u${hex}`
        i += 6
        continue
      }
      result += '\\\\u'
      i += 2
      continue
    }

    const isJsonEscape =
      next === '"' ||
      next === '\\' ||
      next === '/' ||
      next === 'b' ||
      next === 'f' ||
      next === 'n' ||
      next === 'r' ||
      next === 't'

    if (!isJsonEscape) {
      result += `\\\\${next}`
      i += 2
      continue
    }

    const maybeLatexCommand =
      (next === 'b' || next === 'f' || next === 'n' || next === 'r' || next === 't') &&
      /[A-Za-z]/.test(candidate[i + 2] ?? '')

    if (maybeLatexCommand) {
      result += `\\\\${next}`
      i += 2
      continue
    }

    result += `\\${next}`
    i += 2
  }

  return result
}

function parseJsonCandidate(candidate: string): Record<string, unknown> | null {
  const strict = tryParseJsonObject(candidate)
  const repairedCandidate = repairJsonStringBackslashes(candidate)
  const repaired = repairedCandidate === candidate ? null : tryParseJsonObject(repairedCandidate)

  if (strict && repaired) {
    return countSuspiciousControlChars(repaired) < countSuspiciousControlChars(strict)
      ? repaired
      : strict
  }

  return strict ?? repaired
}

function parseAiResponse(raw: string): ParsedAiResponse {
  const candidate = extractJsonCandidate(raw)
  if (!candidate) {
    return {
      analysisMarkdown: raw.trim(),
      generatedAnswers: [],
      answerReasonable: null,
      reasonabilityComment: '',
    }
  }

  const json = parseJsonCandidate(candidate)
  if (!json) {
    return {
      analysisMarkdown: raw.trim(),
      generatedAnswers: [],
      answerReasonable: null,
      reasonabilityComment: '',
    }
  }

  const analysisValue =
    (typeof json.analysis_markdown === 'string' && json.analysis_markdown) ||
    (typeof json.analysis === 'string' && json.analysis) ||
    (typeof json['解析'] === 'string' && (json['解析'] as string)) ||
    raw

  const generatedAnswers = normalizeToStringArray(
    json.generated_answers ?? json.answers ?? json['答案'] ?? json.suggested_answers,
  )

  const answerReasonableRaw =
    json.answer_reasonable ?? json.is_reasonable ?? json.reasonable ?? json['答案是否合理']
  const answerReasonable = typeof answerReasonableRaw === 'boolean' ? answerReasonableRaw : null

  const reasonabilityComment =
    (typeof json.reasonability_comment === 'string' && json.reasonability_comment) ||
    (typeof json.reason === 'string' && json.reason) ||
    (typeof json.comment === 'string' && json.comment) ||
    ''

  return {
    analysisMarkdown: String(analysisValue || '').trim(),
    generatedAnswers,
    answerReasonable,
    reasonabilityComment,
  }
}

function parseChoiceAnswerIndices(
  rawAnswers: string[],
  optionCount: number,
  optionStyle: 'latin' | 'circle',
): number[] {
  const source = rawAnswers.join(' ').toUpperCase()
  const result = new Set<number>()

  const letters = source.match(/[A-Z]/g) ?? []
  for (const token of letters) {
    const index = token.charCodeAt(0) - 65
    if (index >= 0 && index < optionCount) {
      result.add(index)
    }
  }

  const circles = CIRCLE_LABELS.slice(0, optionCount)
  for (let i = 0; i < circles.length; i += 1) {
    if (source.includes(circles[i])) {
      result.add(i)
    }
  }

  const digits = source.match(/\d+/g) ?? []
  for (const token of digits) {
    const index = Number(token) - 1
    if (index >= 0 && index < optionCount) {
      result.add(index)
    }
  }

  if (result.size === 0 && optionStyle === 'circle') {
    for (let i = 0; i < optionCount; i += 1) {
      const fallback = `(${i + 1})`
      if (source.includes(fallback)) {
        result.add(i)
      }
    }
  }

  return [...result].sort((a, b) => a - b)
}

function buildChoiceDisplayMarkdown(question: Question & { type: 'choice' }): string {
  const stemBase = migrateStemTokens(question.normalizedStem)
  const stemWithToken =
    countInlineTokens(stemBase) > 0 ? stemBase : `${stemBase.trimEnd()} [[INLINE_BLANK_1]]`.trim()

  const answerText = question.correctAnswers
    .map((index) => getOptionMarker(index, question.optionStyle))
    .join('、')

  const filledStem = replaceInlineBlanksWithValues(stemWithToken, [answerText])
  const optionLines = question.options
    .map((option, index) => `**${getOptionMarker(index, question.optionStyle)}** ${flattenOptionText(option)}`)
    .join('\n\n')

  return optionLines ? `${filledStem}\n\n${optionLines}` : filledStem
}

function buildBlankDisplayMarkdown(question: Question & { type: 'blank' }): string {
  const stemBase = migrateStemTokens(question.normalizedStem)
  const stemWithToken =
    countInlineTokens(stemBase) > 0 ? stemBase : `${stemBase.trimEnd()} [[INLINE_BLANK_1]]`.trim()
  return replaceInlineBlanksWithValues(stemWithToken, question.answers)
}

function buildSubjectiveDisplayMarkdown(question: Question & { type: 'subjective' }): string {
  const areaCount = countAreaTokens(question.normalizedStem)
  if (areaCount < 1) {
    if (question.answers.length > 0) {
      return `${question.normalizedStem}\n\n${buildAreaBlankHtml(question.answers[0])}`
    }
    return question.normalizedStem
  }
  return replaceAreaBlanksWithValues(question.normalizedStem, question.answers)
}

function buildQuestionDisplayMarkdown(question: Question): string {
  if (question.type === 'choice') return buildChoiceDisplayMarkdown(question)
  if (question.type === 'blank') return buildBlankDisplayMarkdown(question)
  return buildSubjectiveDisplayMarkdown(question)
}

function hydrateQuestions(input: unknown): Question[] {
  if (!Array.isArray(input)) {
    return []
  }

  return input
    .map((rawItem) => {
      if (!rawItem || typeof rawItem !== 'object') {
        return null
      }

      const item = rawItem as Record<string, unknown>
      const base = {
        id: String(item.id ?? crypto.randomUUID()),
        subject: (item.subject as SubjectKey) ?? 'other',
        stem: String(item.stem ?? ''),
        createdAt: String(item.createdAt ?? new Date().toISOString()),
        updatedAt: String(item.updatedAt ?? new Date().toISOString()),
      }

      const type = item.type
      if (type === 'choice') {
        const rawNormalized = migrateStemTokens(String(item.normalizedStem ?? item.stem ?? ''))
        const normalizedStem =
          countInlineTokens(rawNormalized) > 0
            ? rawNormalized
            : `${rawNormalized.trimEnd()} [[INLINE_BLANK_1]]`.trim()

        const options = Array.isArray(item.options)
          ? item.options.map((value) => String(value ?? ''))
          : []

        const optionCount = Number(item.optionCount ?? options.length ?? 4)
        const correctedOptionCount = Math.min(8, Math.max(2, optionCount || 4))
        const paddedOptions = ensureLength(options, correctedOptionCount)

        const answers = Array.isArray(item.correctAnswers)
          ? item.correctAnswers.map((value) => Number(value)).filter((value) => Number.isFinite(value))
          : []

        return {
          ...base,
          type: 'choice' as const,
          normalizedStem,
          choiceMode: (item.choiceMode as ChoiceMode) ?? 'single',
          optionStyle: (item.optionStyle as 'latin' | 'circle') ?? 'latin',
          optionCount: correctedOptionCount,
          options: paddedOptions.slice(0, correctedOptionCount),
          correctAnswers: sanitizeChoiceAnswers(
            ((item.choiceMode as ChoiceMode) ?? 'single'),
            answers,
            correctedOptionCount,
          ),
          analysis: String(item.analysis ?? ''),
        }
      }

      if (type === 'blank') {
        const rawNormalized = migrateStemTokens(String(item.normalizedStem ?? item.stem ?? ''))
        const normalizedStem =
          countInlineTokens(rawNormalized) > 0
            ? rawNormalized
            : `${rawNormalized.trimEnd()} [[INLINE_BLANK_1]]`.trim()

        const blankCount = Math.max(1, countInlineTokens(normalizedStem))
        const answers = Array.isArray(item.answers)
          ? item.answers.map((value) => String(value ?? ''))
          : []

        return {
          ...base,
          type: 'blank' as const,
          normalizedStem,
          blankCount,
          answers: ensureLength(answers, blankCount).slice(0, blankCount),
          analysis: String(item.analysis ?? ''),
        }
      }

      const subjectiveBase = String(item.normalizedStem ?? item.stem ?? '')
      const normalized = normalizeSubjectiveStem(subjectiveBase)
      const normalizedStem = normalized.normalizedStem
      const areaCount = Number(item.areaCount)
      const effectiveAreaCount = Number.isFinite(areaCount)
        ? Math.max(Math.max(0, areaCount), normalized.blankCount)
        : normalized.blankCount
      const requiredAnswers = Math.max(1, effectiveAreaCount)
      const answersSource = Array.isArray(item.answers)
        ? item.answers
        : typeof item.answer === 'string'
          ? [item.answer]
          : []
      const answers = ensureLength(
        answersSource.map((value) => String(value ?? '')),
        requiredAnswers,
      )

      return {
        ...base,
        type: 'subjective' as const,
        normalizedStem,
        areaCount: effectiveAreaCount,
        answers: answers.slice(0, requiredAnswers),
        analysis: String(item.analysis ?? ''),
      }
    })
    .filter((item): item is Question => item !== null)
}

function App() {
  const today = getTodayDateKey()
  const location = useLocation()
  const navigate = useNavigate()

  const [settings, setSettings] = useState<AiSettings>(INITIAL_AI_SETTINGS)
  const [aiSettingsLoaded, setAiSettingsLoaded] = useState(false)
  const [aiSettingsSyncing, setAiSettingsSyncing] = useState(false)
  const [aiSettingsSyncedAt, setAiSettingsSyncedAt] = useState<string | null>(null)
  const [questions, setQuestions] = useState<Question[]>(() =>
    hydrateQuestions(fromLocalStorage(QUESTIONS_KEY, [])),
  )
  const [draft, setDraft] = useState<DraftState>(() => ({
    ...createInitialDraft(),
    subject: getLastCreatedSubject(),
  }))
  const [notice, setNotice] = useState('')
  const [aiLoadingTarget, setAiLoadingTarget] = useState<AnalysisTarget | null>(null)
  const [pdfExporting, setPdfExporting] = useState(false)
  const [pdfExportingTarget, setPdfExportingTarget] = useState<PdfExportTarget | null>(null)

  const [bankCreditFilter, setBankCreditFilter] = useState<CreditFilter>('all')
  const [bankTypeFilter, setBankTypeFilter] = useState<TypeFilter>('all')
  const [startDate, setStartDate] = useState(today)
  const [endDate, setEndDate] = useState(today)
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(null)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const imageMemoryRef = useRef<Record<string, string>>({})
  const imageIdByDataUrlRef = useRef<Record<string, string>>({})
  const blobUrlByDataUrlRef = useRef<Record<string, string>>({})
  const imageIndexRef = useRef(1)

  const rememberImageInMemory = useCallback((dataUrl: string): string => {
    const existingId = imageIdByDataUrlRef.current[dataUrl]
    if (existingId) {
      return existingId
    }

    const imageId = `image_${imageIndexRef.current}`
    imageMemoryRef.current[imageId] = dataUrl
    imageIdByDataUrlRef.current[dataUrl] = imageId
    imageIndexRef.current += 1
    return imageId
  }, [])

  const resolveImageUrlForRender = useCallback((src: string): string => {
    const normalizedSrc = src.trim()
    const rawSrc = IMAGE_ID_URL_REGEX.test(normalizedSrc)
      ? imageMemoryRef.current[normalizedSrc] ?? normalizedSrc
      : normalizedSrc

    if (!isBase64ImageUrl(rawSrc)) {
      return rawSrc
    }

    const cachedBlobUrl = blobUrlByDataUrlRef.current[rawSrc]
    if (cachedBlobUrl) {
      return cachedBlobUrl
    }

    const generatedBlobUrl = convertDataImageToBlobUrl(rawSrc)
    if (!generatedBlobUrl) {
      return rawSrc
    }

    blobUrlByDataUrlRef.current[rawSrc] = generatedBlobUrl
    return generatedBlobUrl
  }, [])

  const resolveMarkdownForRender = useCallback(
    (value: string): string => {
      if (!value.includes('![')) {
        return value
      }
      if (!value.includes('image_') && !value.includes('data:image/')) {
        return value
      }

      return value.replace(MARKDOWN_IMAGE_REGEX, (full, alt: string, url: string, title?: string) => {
        const normalizedUrl = url.trim()
        const resolvedUrl = resolveImageUrlForRender(normalizedUrl)
        if (resolvedUrl === normalizedUrl) {
          return full
        }
        const suffix = typeof title === 'string' ? title : ''
        return `![${alt}](${resolvedUrl}${suffix})`
      })
    },
    [resolveImageUrlForRender],
  )

  useEffect(() => {
    const blobUrlCache = blobUrlByDataUrlRef.current
    return () => {
      for (const blobUrl of Object.values(blobUrlCache)) {
        URL.revokeObjectURL(blobUrl)
      }
    }
  }, [])

  const materializeMarkdownForStorage = (value: string): string => {
    return materializeImageIds(value, imageMemoryRef.current)
  }

  const normalizeMarkdownForEdit = useCallback(
    (value: string): string => {
      return convertLongBase64ImagesToIds(value, rememberImageInMemory)
    },
    [rememberImageInMemory],
  )

  const resolveMarkdownForPreview = useCallback(
    (value: string): string => resolveMarkdownForRender(value),
    [resolveMarkdownForRender],
  )

  const syncAiSettingsFromCloud = useCallback(
    async (withSuccessNotice = false) => {
      setAiSettingsSyncing(true)
      try {
        const headers: HeadersInit = {}
        if (AI_SETTINGS_CLOUD_TOKEN) {
          headers.Authorization = `Bearer ${AI_SETTINGS_CLOUD_TOKEN}`
        }

        const response = await fetch(AI_SETTINGS_CLOUD_URL, {
          method: 'GET',
          headers,
        })
        if (!response.ok) {
          throw new Error(`云端配置拉取失败（HTTP ${response.status}）`)
        }

        const payload = (await response.json()) as unknown
        const parsed = parseAiSettingsFromPayload(payload)
        if (!parsed) {
          throw new Error('云端配置格式错误，请检查接口返回。')
        }

        setSettings(parsed)
        const syncedAt = new Date().toISOString()
        setAiSettingsSyncedAt(syncedAt)
        if (withSuccessNotice) {
          setNotice('已从云端同步 AI 配置。')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '云端配置拉取失败'
        setNotice(message)
      } finally {
        setAiSettingsSyncing(false)
        setAiSettingsLoaded(true)
      }
    },
    [setNotice],
  )

  useEffect(() => {
    void syncAiSettingsFromCloud(false)
  }, [syncAiSettingsFromCloud])

  const pathname = location.pathname
  const pathnameLower = pathname.toLowerCase()
  const editPathQuestionId = parseEditQuestionIdFromPath(pathname)
  const isEditing = editPathQuestionId !== null

  const aiConfigured =
    settings.enabled &&
    settings.baseUrl.trim().length > 0 &&
    settings.apiKey.trim().length > 0 &&
    settings.model.trim().length > 0

  const knownPaths = ['/create', '/bank', '/settings', '/']
  const isKnownPath = knownPaths.includes(pathnameLower) || editPathQuestionId !== null
  const currentTab =
    pathnameLower === '/settings' ? 'settings' : pathnameLower === '/bank' ? 'bank' : 'create'

  const detectedChoiceBlankCount = useMemo(() => detectInlineBlankCount(draft.stem), [draft.stem])
  const detectedBlankCount = useMemo(() => detectInlineBlankCount(draft.stem), [draft.stem])
  const subjectiveNormalization = useMemo(() => normalizeSubjectiveStem(draft.stem), [draft.stem])
  const detectedSubjectiveBlankCount = subjectiveNormalization.blankCount
  const subjectiveAppendedTrailingBlank = subjectiveNormalization.appendedTrailing

  const blankSlotCount = Math.max(1, detectedBlankCount)
  const subjectiveSlotCount = Math.max(1, detectedSubjectiveBlankCount)

  const visibleChoiceOptions = draft.options.slice(0, draft.optionCount)

  const dateRange = useMemo(() => {
    const left = startDate || today
    const right = endDate || left
    return left <= right ? { start: left, end: right } : { start: right, end: left }
  }, [startDate, endDate, today])

  const bankList = useMemo(() => {
    return questions.filter((item) => {
      const creditOk =
        bankCreditFilter === 'all' ||
        getQuestionCreditCategory(item.subject) === bankCreditFilter
      const typeOk = bankTypeFilter === 'all' || item.type === bankTypeFilter
      const createdDate = item.createdAt.slice(0, 10)
      const dateOk = createdDate >= dateRange.start && createdDate <= dateRange.end
      return creditOk && typeOk && dateOk
    })
  }, [questions, bankCreditFilter, bankTypeFilter, dateRange])

  const bankRenderList = useMemo(
    () =>
      bankList.map((question) => ({
        question,
        displayMarkdown: resolveMarkdownForRender(buildQuestionDisplayMarkdown(question)),
        analysisMarkdown: question.analysis
          ? resolveMarkdownForRender(question.analysis)
          : '',
      })),
    [bankList, resolveMarkdownForRender],
  )

  useEffect(() => {
    toLocalStorage(QUESTIONS_KEY, questions)
  }, [questions])

  useEffect(() => {
    if (!aiSettingsLoaded) {
      return
    }

    if (!isKnownPath) {
      navigate(aiConfigured ? '/create' : '/settings', { replace: true })
      return
    }

    if (pathnameLower === '/') {
      navigate(aiConfigured ? '/create' : '/settings', { replace: true })
      return
    }

    if (!aiConfigured && currentTab !== 'settings') {
      navigate('/settings', { replace: true })
    }
  }, [aiConfigured, aiSettingsLoaded, currentTab, isKnownPath, navigate, pathnameLower])

  useEffect(() => {
    setMobileMenuOpen(false)
  }, [pathnameLower, editPathQuestionId])

  useEffect(() => {
    if (!editPathQuestionId) {
      return
    }

    const targetQuestion = questions.find((item) => item.id === editPathQuestionId)
    if (!targetQuestion) {
      setEditingQuestionId(null)
      setNotice(`未找到 ID 为 ${editPathQuestionId} 的题目，已返回创建页。`)
      navigate('/create', { replace: true })
      return
    }

    if (editingQuestionId === targetQuestion.id) {
      return
    }

    setDraft(buildDraftFromQuestion(targetQuestion, normalizeMarkdownForEdit))
    setEditingQuestionId(targetQuestion.id)
  }, [editPathQuestionId, editingQuestionId, navigate, normalizeMarkdownForEdit, questions])

  useEffect(() => {
    if (editPathQuestionId !== null) {
      return
    }
    if (editingQuestionId === null) {
      return
    }
    setEditingQuestionId(null)
  }, [editPathQuestionId, editingQuestionId])

  useEffect(() => {
    if (!notice) {
      return undefined
    }
    const timer = window.setTimeout(() => setNotice(''), 3200)
    return () => window.clearTimeout(timer)
  }, [notice])

  const updateDraft = <K extends keyof DraftState>(key: K, value: DraftState[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const updateStem = (stem: string) => {
    const normalizedStem = normalizeMarkdownForEdit(stem)
    setDraft((prev) => {
      if (prev.type === 'blank') {
        const nextSlotCount = Math.max(1, detectInlineBlankCount(normalizedStem))
        return {
          ...prev,
          stem: normalizedStem,
          fillAnswers: ensureLength(prev.fillAnswers, nextSlotCount),
        }
      }

      if (prev.type === 'subjective') {
        const nextSlotCount = Math.max(1, normalizeSubjectiveStem(normalizedStem).blankCount)
        return {
          ...prev,
          stem: normalizedStem,
          subjectiveAnswers: ensureLength(prev.subjectiveAnswers, nextSlotCount),
        }
      }

      return {
        ...prev,
        stem: normalizedStem,
      }
    })
  }

  const updateQuestionType = (type: QuestionType) => {
    setDraft((prev) => {
      if (type === 'blank') {
        const nextSlotCount = Math.max(1, detectInlineBlankCount(prev.stem))
        return {
          ...prev,
          type,
          fillAnswers: ensureLength(prev.fillAnswers, nextSlotCount),
        }
      }

      if (type === 'subjective') {
        const nextSlotCount = Math.max(1, normalizeSubjectiveStem(prev.stem).blankCount)
        return {
          ...prev,
          type,
          subjectiveAnswers: ensureLength(prev.subjectiveAnswers, nextSlotCount),
        }
      }

      return {
        ...prev,
        type,
      }
    })
  }

  const updateOptionCount = (rawCount: number) => {
    const count = Math.min(8, Math.max(2, rawCount))
    setDraft((prev) => {
      const nextOptions =
        count > prev.options.length
          ? [...prev.options, ...Array.from({ length: count - prev.options.length }, () => '')]
          : prev.options

      return {
        ...prev,
        optionCount: count,
        options: nextOptions,
      }
    })
  }

  const updateChoiceOption = (index: number, value: string) => {
    setDraft((prev) => {
      const nextOptions = [...prev.options]
      nextOptions[index] = value
      return {
        ...prev,
        options: nextOptions,
      }
    })
  }

  const updateFillAnswer = (index: number, value: string) => {
    setDraft((prev) => {
      const nextAnswers = [...prev.fillAnswers]
      nextAnswers[index] = value
      return {
        ...prev,
        fillAnswers: nextAnswers,
      }
    })
  }

  const updateSubjectiveAnswer = (index: number, value: string) => {
    setDraft((prev) => {
      const nextAnswers = [...prev.subjectiveAnswers]
      nextAnswers[index] = value
      return {
        ...prev,
        subjectiveAnswers: nextAnswers,
      }
    })
  }

  const toggleChoiceAnswer = (index: number) => {
    setDraft((prev) => {
      if (prev.choiceMode === 'single') {
        return {
          ...prev,
          choiceAnswers: [index],
        }
      }

      const exists = prev.choiceAnswers.includes(index)
      const next = exists
        ? prev.choiceAnswers.filter((item) => item !== index)
        : [...prev.choiceAnswers, index]

      return {
        ...prev,
        choiceAnswers: next,
      }
    })
  }

  const clearDraft = () => {
    const wasEditing = editPathQuestionId !== null
    setDraft((prev) => ({
      ...createInitialDraft(),
      subject: prev.subject,
      type: prev.type,
    }))
    setEditingQuestionId(null)
    if (wasEditing) {
      navigate('/create')
    }
    setNotice('已清空当前草稿。')
  }

  const startEditQuestion = (question: Question) => {
    navigate(`/edit/${encodeURIComponent(question.id)}`)
    setNotice('已进入编辑模式，支持继续插入图片。')
  }

  const deleteQuestion = (questionId: string) => {
    const confirmed = window.confirm('确认删除这道题目吗？删除后无法恢复。')
    if (!confirmed) {
      return
    }

    setQuestions((prev) => prev.filter((item) => item.id !== questionId))
    if (editingQuestionId === questionId || editPathQuestionId === questionId) {
      setEditingQuestionId(null)
      navigate('/create', { replace: true })
    }
    setNotice('题目已删除。')
  }

  const submitQuestion = () => {
    const stem = draft.stem.trim()
    if (!stem) {
      setNotice('请先输入题面。')
      return
    }

    const now = new Date().toISOString()
    const originalQuestion = editPathQuestionId
      ? questions.find((item) => item.id === editPathQuestionId)
      : null
    const questionId = originalQuestion?.id ?? crypto.randomUUID()
    const createdAt = originalQuestion?.createdAt ?? now

    if (draft.type === 'choice') {
      const normalized = normalizeChoiceStem(stem)
      const options = draft.options.slice(0, draft.optionCount).map((item) => item.trim())
      if (options.some((item) => item.length === 0)) {
        setNotice('选择题每个选项都需要有内容。')
        return
      }

      const answers = sanitizeChoiceAnswers(draft.choiceMode, draft.choiceAnswers, draft.optionCount)
      if (!validateChoiceAnswers(draft.choiceMode, answers)) {
        if (draft.choiceMode === 'single') {
          setNotice('单选题必须且只能选择 1 个正确选项。')
          return
        }
        if (draft.choiceMode === 'double') {
          setNotice('双选题必须选择 2 个正确选项。')
          return
        }
        setNotice('不定项选择题至少要有 1 个正确选项。')
        return
      }

      const nextQuestion: Question = {
        id: questionId,
        subject: draft.subject,
        type: 'choice',
        stem: materializeMarkdownForStorage(stem),
        normalizedStem: materializeMarkdownForStorage(normalized.normalizedStem),
        createdAt,
        updatedAt: now,
        choiceMode: draft.choiceMode,
        optionStyle: draft.optionStyle,
        optionCount: draft.optionCount,
        options: options.map((item) => materializeMarkdownForStorage(item)),
        correctAnswers: answers,
        analysis: materializeMarkdownForStorage(draft.choiceAnalysis.trim()),
      }

      setQuestions((prev) =>
        originalQuestion
          ? prev.map((item) => (item.id === questionId ? nextQuestion : item))
          : [nextQuestion, ...prev],
      )
      if (!originalQuestion) {
        toLocalStorage(LAST_CREATED_SUBJECT_KEY, draft.subject)
      }

      if (originalQuestion) {
        if (normalized.appended) {
          setNotice('选择题未识别到空位，已默认在题面末尾追加一个空位并更新。')
        } else if (normalized.hadMultiple) {
          setNotice('选择题只支持一个空位，已按最后一个空位更新。')
        } else {
          setNotice('选择题已更新。')
        }
      } else {
        setNotice('创建成功')
      }

      setDraft((prev) => ({
        ...createInitialDraft(),
        subject: prev.subject,
        type: prev.type,
      }))
      if (originalQuestion) {
        navigate('/bank', { replace: true })
      }
      return
    }

    if (draft.type === 'blank') {
      const normalized = normalizeBlankStem(stem)
      const answers = ensureLength(draft.fillAnswers, normalized.blankCount)
        .slice(0, normalized.blankCount)
        .map((item) => item.trim())

      const nextQuestion: Question = {
        id: questionId,
        subject: draft.subject,
        type: 'blank',
        stem: materializeMarkdownForStorage(stem),
        normalizedStem: materializeMarkdownForStorage(normalized.normalizedStem),
        createdAt,
        updatedAt: now,
        blankCount: normalized.blankCount,
        answers: answers.map((item) => materializeMarkdownForStorage(item)),
        analysis: materializeMarkdownForStorage(draft.fillAnalysis.trim()),
      }

      setQuestions((prev) =>
        originalQuestion
          ? prev.map((item) => (item.id === questionId ? nextQuestion : item))
          : [nextQuestion, ...prev],
      )
      if (!originalQuestion) {
        toLocalStorage(LAST_CREATED_SUBJECT_KEY, draft.subject)
      }
      if (originalQuestion) {
        setNotice(
          normalized.appended
            ? '填空题未识别到空位，已默认在题面末尾追加一个空位并更新。'
            : '填空题已更新。',
        )
      } else {
        setNotice('创建成功')
      }
      setDraft((prev) => ({
        ...createInitialDraft(),
        subject: prev.subject,
        type: prev.type,
      }))
      if (originalQuestion) {
        navigate('/bank', { replace: true })
      }
      return
    }

    const normalized = normalizeSubjectiveStem(stem)
    const answerCount = Math.max(1, normalized.blankCount)
    const answers = ensureLength(draft.subjectiveAnswers, answerCount)
      .slice(0, answerCount)
      .map((item) => item.trim())

    const nextQuestion: Question = {
      id: questionId,
      subject: draft.subject,
      type: 'subjective',
      stem: materializeMarkdownForStorage(stem),
      normalizedStem: materializeMarkdownForStorage(normalized.normalizedStem),
      createdAt,
      updatedAt: now,
      areaCount: normalized.blankCount,
      answers: answers.map((item) => materializeMarkdownForStorage(item)),
      analysis: materializeMarkdownForStorage(draft.subjectiveAnalysis.trim()),
    }

    setQuestions((prev) =>
      originalQuestion
        ? prev.map((item) => (item.id === questionId ? nextQuestion : item))
        : [nextQuestion, ...prev],
    )
    if (!originalQuestion) {
      toLocalStorage(LAST_CREATED_SUBJECT_KEY, draft.subject)
    }
    if (originalQuestion) {
      setNotice(
        normalized.appendedTrailing
          ? '主观题已更新，并在题面末尾自动补了一个答案空位。'
          : '主观题已更新。',
      )
    } else {
      setNotice('创建成功')
    }
    setDraft((prev) => ({
      ...createInitialDraft(),
      subject: prev.subject,
      type: prev.type,
    }))
    if (originalQuestion) {
      navigate('/bank', { replace: true })
    }
  }

  const generateAnalysisWithAI = async (target: AnalysisTarget) => {
    if (!aiConfigured) {
      setNotice('请先在设置页同步云端 AI 配置。')
      return
    }

    const stem = draft.stem.trim()
    if (!stem) {
      setNotice('请先输入题面。')
      return
    }

    let answerProvided = false
    let shouldGenerateAnswers = false
    let givenAnswerText = ''
    let answerCount = 1

    if (target === 'choice') {
      const selected = sanitizeChoiceAnswers(draft.choiceMode, draft.choiceAnswers, draft.optionCount)
      answerProvided = validateChoiceAnswers(draft.choiceMode, selected)
      givenAnswerText = selected
        .map((index) => getOptionMarker(index, draft.optionStyle))
        .join('、')
      answerCount = draft.choiceMode === 'double' ? 2 : 1
    } else if (target === 'blank') {
      answerCount = Math.max(1, normalizeBlankStem(stem).blankCount)
      const answers = ensureLength(draft.fillAnswers, answerCount)
        .slice(0, answerCount)
        .map((item) => item.trim())
      answerProvided = answers.every((item) => item.length > 0)
      givenAnswerText = answers
        .map((item, index) => `第${index + 1}空：${item || '（空）'}`)
        .join('\n')
    } else {
      answerCount = Math.max(1, normalizeSubjectiveStem(stem).blankCount)
      const answers = ensureLength(draft.subjectiveAnswers, answerCount)
        .slice(0, answerCount)
        .map((item) => item.trim())
      answerProvided = answers.every((item) => item.length > 0)
      givenAnswerText = answers
        .map((item, index) => `第${index + 1}空：${item || '（空）'}`)
        .join('\n')
    }

    if (!answerProvided) {
      const confirmed = window.confirm(
        '当前未填写完整答案。继续后 AI 会同时生成答案和解析，是否继续？',
      )
      if (!confirmed) {
        return
      }
      shouldGenerateAnswers = true
    }

    const isHumanities = HUMANITIES_SUBJECTS.has(draft.subject)
    const isScience = SCIENCE_SUBJECTS.has(draft.subject)
    const forceKeepGivenAnswer = isHumanities && answerProvided
    const shouldCheckReasonability = isScience && answerProvided

    const subjectLabel = SUBJECT_MAP[draft.subject].label
    const endpoint = buildAIEndpoint(settings.baseUrl)

    let questionBody = `学科：${subjectLabel}\n题型：${QUESTION_TYPE_LABEL[target]}\n\n题面：\n${stem}\n`

    if (target === 'choice') {
      const options = draft.options.slice(0, draft.optionCount).map((item) => item.trim())
      if (options.some((item) => item.length === 0)) {
        setNotice('请先补全选择题选项，再生成解析。')
        return
      }
      const optionsText = options
        .map((option, index) => `${getOptionMarker(index, draft.optionStyle)} ${option}`)
        .join('\n')
      questionBody += `\n选项：\n${optionsText}\n`
    }

    if (answerProvided) {
      questionBody += `\n当前答案：\n${givenAnswerText}\n`
    } else {
      questionBody += `\n当前答案：未填写完整\n`
    }

    const policyLines = [
      '输出要求：优先返回 JSON（可放在 ```json 代码块中），字段如下：',
      '{"analysis_markdown":"...","generated_answers":["..."],"answer_reasonable":true/false/null,"reasonability_comment":"..."}',
      '若无法返回 JSON，至少返回 Markdown 解析正文。',
      'analysis_markdown 必须是 Markdown。',
      'analysis_markdown 严禁使用任何 Markdown 标题（如 #、##、###、####）。',
      '解析需以答案编写者身份直接讲解，不写“解析/选项分析/结论”等小标题，没有“我”之类主语。',
      '可使用 Markdown 列表与 LaTeX；整体解析以自然段为主。',
      '解析总字数尽量控制在 400 字以内。',
      '结尾不要写“当前答案可以成立”等审查式语句。',
      `generated_answers 若需要提供答案，长度应为 ${answerCount}（选择题可用选项标识符）。`,
    ]

    if (target === 'choice') {
      policyLines.push(
        '选择题在逐个分析选项（A/B/C/D...）时建议使用列表；其余部分保持自然段表达。',
      )
      policyLines.push(
        '分析不得说空话、套话，不要简单复述或抄写选项原文；除非该选项结论显而易见。',
      )
      if (isHumanities) {
        policyLines.push('文科选择题需结合题干材料与所学知识说明依据，并尽量指出对应来源。')
      }
    }

    if (shouldGenerateAnswers) {
      policyLines.push('由于当前答案缺失：必须返回 generated_answers，并生成 analysis_markdown。')
    } else if (forceKeepGivenAnswer) {
      policyLines.push('必须严格沿用当前答案，不得改写答案。generated_answers 置空。')
      policyLines.push('answer_reasonable 固定返回 null。')
    } else if (shouldCheckReasonability) {
      policyLines.push('需要判断当前答案是否合理，并返回 answer_reasonable。')
      policyLines.push('若不合理，请在 generated_answers 给出建议替代答案。')
    }

    const userPrompt = `${questionBody}\n${policyLines.join('\n')}`
    const userMessageContent = buildUserMessageContent(userPrompt, imageMemoryRef.current)

    setAiLoadingTarget(target)

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          temperature: 0.3,
          messages: [
            {
              role: 'system',
              content:
                '你是高中错题解析助手。输出应简洁准确，解析采用 Markdown；不要使用任何标题；以答案编写者口吻直接讲解；整体以自然段为主，仅在逐项分析选项时可用列表；可使用 LaTeX；总字数尽量控制在 400 字以内。',
            },
            {
              role: 'user',
              content: userMessageContent,
            },
          ],
        }),
      })

      if (!response.ok) {
        throw new Error(`AI 请求失败（HTTP ${response.status}）`)
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = data.choices?.[0]?.message?.content?.trim()
      if (!content) {
        throw new Error('AI 返回为空，请检查模型兼容性。')
      }

      const parsed = parseAiResponse(content)
      const analysis = parsed.analysisMarkdown || content

      if (target === 'choice') {
        const suggestedIndices = parseChoiceAnswerIndices(
          parsed.generatedAnswers,
          draft.optionCount,
          draft.optionStyle,
        )

        if (shouldGenerateAnswers) {
          const generated = sanitizeChoiceAnswers(draft.choiceMode, suggestedIndices, draft.optionCount)
          if (!validateChoiceAnswers(draft.choiceMode, generated)) {
            setDraft((prev) => ({
              ...prev,
              choiceAnalysis: analysis,
            }))
            setNotice('AI 已生成解析，但返回的答案格式不完整，请手动确认正确答案。')
            return
          }

          setDraft((prev) => ({
            ...prev,
            choiceAnalysis: analysis,
            choiceAnswers: generated,
          }))
          setNotice('AI 已生成选择题答案与解析。')
          return
        }

        if (shouldCheckReasonability && parsed.answerReasonable === false && suggestedIndices.length > 0) {
          const generated = sanitizeChoiceAnswers(draft.choiceMode, suggestedIndices, draft.optionCount)
          const canUse = validateChoiceAnswers(draft.choiceMode, generated)

          if (canUse) {
            const reasonText = parsed.reasonabilityComment || 'AI 认为当前答案可能不合理。'
            const confirmed = window.confirm(
              `${reasonText}\n\n是否使用 AI 建议答案覆盖当前答案？`,
            )

            if (confirmed) {
              setDraft((prev) => ({
                ...prev,
                choiceAnalysis: analysis,
                choiceAnswers: generated,
              }))
              setNotice('AI 建议答案已覆盖，解析已更新。')
              return
            }

            setDraft((prev) => ({
              ...prev,
              choiceAnalysis: analysis,
            }))
            setNotice('已保留原答案，仅更新解析。')
            return
          }
        }

        setDraft((prev) => ({
          ...prev,
          choiceAnalysis: analysis,
        }))
        setNotice('选择题 AI 解析已生成。')
        return
      }

      if (target === 'blank') {
        const requiredCount = Math.max(1, normalizeBlankStem(stem).blankCount)
        const suggested = ensureLength(parsed.generatedAnswers, requiredCount)
          .slice(0, requiredCount)
          .map((item) => item.trim())

        if (shouldGenerateAnswers) {
          const hasGenerated = suggested.some((item) => item.length > 0)
          if (!hasGenerated) {
            setDraft((prev) => ({
              ...prev,
              fillAnalysis: analysis,
            }))
            setNotice('AI 已生成解析，但未给出完整答案，请手动补充。')
            return
          }

          setDraft((prev) => ({
            ...prev,
            fillAnalysis: analysis,
            fillAnswers: suggested,
          }))
          setNotice('AI 已生成填空题答案与解析。')
          return
        }

        if (shouldCheckReasonability && parsed.answerReasonable === false) {
          const hasGenerated = suggested.some((item) => item.length > 0)
          if (hasGenerated) {
            const reasonText = parsed.reasonabilityComment || 'AI 认为当前答案可能不合理。'
            const confirmed = window.confirm(
              `${reasonText}\n\n是否使用 AI 建议答案覆盖当前答案？`,
            )

            if (confirmed) {
              setDraft((prev) => ({
                ...prev,
                fillAnalysis: analysis,
                fillAnswers: suggested,
              }))
              setNotice('AI 建议答案已覆盖，解析已更新。')
              return
            }
          }
        }

        setDraft((prev) => ({
          ...prev,
          fillAnalysis: analysis,
        }))
        setNotice('填空题 AI 解析已生成。')
        return
      }

      const requiredCount = Math.max(1, normalizeSubjectiveStem(stem).blankCount)
      const suggested = ensureLength(parsed.generatedAnswers, requiredCount)
        .slice(0, requiredCount)
        .map((item) => item.trim())

      if (shouldGenerateAnswers) {
        const hasGenerated = suggested.some((item) => item.length > 0)
        if (!hasGenerated) {
          setDraft((prev) => ({
            ...prev,
            subjectiveAnalysis: analysis,
          }))
          setNotice('AI 已生成解析，但未给出完整答案，请手动补充。')
          return
        }

        setDraft((prev) => ({
          ...prev,
          subjectiveAnalysis: analysis,
          subjectiveAnswers: suggested,
        }))
        setNotice('AI 已生成主观题答案与解析。')
        return
      }

      if (shouldCheckReasonability && parsed.answerReasonable === false) {
        const hasGenerated = suggested.some((item) => item.length > 0)
        if (hasGenerated) {
          const reasonText = parsed.reasonabilityComment || 'AI 认为当前答案可能不合理。'
          const confirmed = window.confirm(`${reasonText}\n\n是否使用 AI 建议答案覆盖当前答案？`)
          if (confirmed) {
            setDraft((prev) => ({
              ...prev,
              subjectiveAnalysis: analysis,
              subjectiveAnswers: suggested,
            }))
            setNotice('AI 建议答案已覆盖，解析已更新。')
            return
          }
        }
      }

      setDraft((prev) => ({
        ...prev,
        subjectiveAnalysis: analysis,
      }))
      setNotice('主观题 AI 解析已生成。')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI 解析生成失败'
      setNotice(message)
    } finally {
      setAiLoadingTarget(null)
    }
  }

  const exportPdf = async (target: PdfExportTarget) => {
    const includeAnalysis = target === 'analysis'
    if (bankList.length === 0) {
      setNotice('当前筛选下暂无题目可导出。')
      return
    }

    setPdfExporting(true)
    setPdfExportingTarget(target)
    setNotice('正在生成 PDF，请稍候...')
    try {
      const { exportQuestionsAsPdf } = await import('./lib/pdfExport')
      const result = await exportQuestionsAsPdf(bankList, {
        includeAnalysis,
      })
      setNotice(result.message)
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出 PDF 失败，请重试。'
      setNotice(message)
    } finally {
      setPdfExporting(false)
      setPdfExportingTarget(null)
    }
  }

  const hiddenOptionDraftCount = Math.max(draft.options.length - draft.optionCount, 0)
  const hiddenBlankDraftCount = Math.max(draft.fillAnswers.length - blankSlotCount, 0)
  const hiddenSubjectiveDraftCount = Math.max(
    draft.subjectiveAnswers.length - subjectiveSlotCount,
    0,
  )

  const navigateToTab = (tab: 'create' | 'bank' | 'settings') => {
    navigate(`/${tab}`)
    setMobileMenuOpen(false)
  }
  return (
    <div className={`app-shell ${mobileMenuOpen ? 'menu-open' : ''}`}>
      <div className="desktop-only">
        <aside className="sidebar">
          <button
            type="button"
            className="sidebar-close-btn"
            aria-label="关闭菜单"
            onClick={() => setMobileMenuOpen(false)}
          >
            收起
          </button>

          <div className="brand">
            <p className="brand-badge">Correct</p>
            <h1>错题整理台</h1>
            <p>私有部署 · 单用户 · 免登录</p>
          </div>

          <nav className="menu">
            <button
              type="button"
              className={currentTab === 'create' ? 'active' : ''}
              disabled={!aiConfigured}
              onClick={() => navigateToTab('create')}
            >
              创建题目
            </button>
            <button
              type="button"
              className={currentTab === 'bank' ? 'active' : ''}
              disabled={!aiConfigured}
              onClick={() => navigateToTab('bank')}
            >
              题库
            </button>
            <button
              type="button"
              className={currentTab === 'settings' ? 'active' : ''}
              onClick={() => navigateToTab('settings')}
            >
              设置
            </button>
          </nav>

          <div className="sidebar-meta">
            <p>题目总数：{questions.length}</p>
          </div>
        </aside>

        <button
          type="button"
          className="mobile-backdrop"
          aria-label="关闭菜单"
          onClick={() => setMobileMenuOpen(false)}
        />

        <main className="main-pane">
          <header className="mobile-topbar">
            <button
              type="button"
              className="mobile-menu-btn"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              aria-label={mobileMenuOpen ? '关闭菜单' : '打开菜单'}
              aria-expanded={mobileMenuOpen}
            >
              菜单
            </button>
            <div className="mobile-topbar-title">错题整理台</div>
          </header>

          {!aiConfigured ? (
            <div className="alert">
              {!aiSettingsLoaded || aiSettingsSyncing
                ? '正在从云端同步 AI 配置，请稍候。'
                : 'AI 云端配置当前不可用，请到“设置”页重新同步后再试。'}
            </div>
          ) : null}

          {currentTab === 'settings' ? (
            <section className="pane">
              <header className="pane-head">
                <h2>AI 设置</h2>
                <p>AI 配置由云端统一管理，本地不会保存或覆盖配置。</p>
              </header>

              <div className="settings-grid">
                <label>
                  云端配置地址
                  <input type="text" value={AI_SETTINGS_CLOUD_URL} readOnly />
                </label>

                <label>
                  Base URL
                  <input
                    type="text"
                    value={settings.baseUrl || '未配置'}
                    readOnly
                  />
                </label>

                <label>
                  API Key
                  <input type="text" value={maskSecret(settings.apiKey)} readOnly />
                </label>

                <label>
                  模型名称
                  <input type="text" value={settings.model || '未配置'} readOnly />
                </label>
              </div>

              <div className="settings-actions">
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => void syncAiSettingsFromCloud(true)}
                  disabled={aiSettingsSyncing}
                >
                  {aiSettingsSyncing ? '同步中...' : '重新同步云端配置'}
                </button>
                <p className={aiConfigured ? 'status-ok' : 'status-warn'}>
                  当前状态：
                  {aiSettingsSyncing || !aiSettingsLoaded ? '同步中' : aiConfigured ? '可用' : '不可用'}
                </p>
                <p className="hint">
                  最近同步：{aiSettingsSyncedAt ? formatDateTime(aiSettingsSyncedAt) : '尚未成功同步'}
                </p>
              </div>
            </section>
          ) : null}

          {currentTab === 'create' ? (
            <section className="pane">
              <header className="pane-head">
                <h2>{isEditing ? '编辑题目' : '创建题目'}</h2>
                <p>全部字段支持 Markdown 与 LaTeX，题面和解析都可插入多张图片。</p>
              </header>

              {isEditing ? (
                <div className="alert">
                  当前为编辑模式。保存后会覆盖原题；图片占位符会在提交时自动回填为真实地址。
                </div>
              ) : null}

              <section className="quick-form">
                <div className="type-picker">
                  <p>题目类型</p>
                  <div>
                    {(Object.keys(QUESTION_TYPE_LABEL) as QuestionType[]).map((type) => (
                      <button
                        key={type}
                        type="button"
                        className={draft.type === type ? 'active' : ''}
                        onClick={() => updateQuestionType(type)}
                      >
                        {QUESTION_TYPE_LABEL[type]}
                      </button>
                    ))}
                  </div>
                </div>

                <MarkdownEditor
                  label="题面"
                  value={draft.stem}
                  onChange={updateStem}
                  allowImages
                  onResolveImageDataUrl={rememberImageInMemory}
                  resolveMarkdownForPreview={resolveMarkdownForPreview}
                  minRows={8}
                  placeholder={`可输入 Markdown 与 LaTeX。
选择题/填空题可用括号、下划线，或两侧有空白字符的 ▲ 表示空位；材料题可用连续换行或独立 ▲ 表示大面积留空。`}
                />

                {draft.type === 'choice' ? (
                  <section className="section-block">
                    <h3>选择题参数</h3>

                    <div className="inline-grid">
                      <label>
                        选择题子类型
                        <select
                          value={draft.choiceMode}
                          onChange={(event) => {
                            updateDraft('choiceMode', event.target.value as ChoiceMode)
                            if (event.target.value === 'single' && draft.choiceAnswers.length > 1) {
                              setDraft((prev) => ({
                                ...prev,
                                choiceAnswers:
                                  prev.choiceAnswers.length > 0 ? [prev.choiceAnswers[0]] : [],
                              }))
                            }
                          }}
                        >
                          {(Object.keys(CHOICE_MODE_LABEL) as ChoiceMode[]).map((mode) => (
                            <option key={mode} value={mode}>
                              {CHOICE_MODE_LABEL[mode]}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label>
                        选项风格
                        <select
                          value={draft.optionStyle}
                          onChange={(event) =>
                            updateDraft('optionStyle', event.target.value as 'latin' | 'circle')
                          }
                        >
                          <option value="latin">ABCD</option>
                          <option value="circle">①②③</option>
                        </select>
                      </label>

                      <label>
                        选项数量
                        <input
                          type="number"
                          min={2}
                          max={8}
                          value={draft.optionCount}
                          onChange={(event) => updateOptionCount(Number(event.target.value))}
                        />
                      </label>
                    </div>

                    {detectedChoiceBlankCount === 0 ? (
                      <p className="hint">未识别到空位时，系统会在题面末尾自动追加一个空位。</p>
                    ) : null}
                    {detectedChoiceBlankCount > 1 ? (
                      <p className="warn-text">选择题最多支持一个空位，保存时将按最后一个空位处理。</p>
                    ) : null}

                    {hiddenOptionDraftCount > 0 ? (
                      <p className="hint">
                        当前隐藏了 {hiddenOptionDraftCount} 个选项草稿，若再调大数量可恢复内容。
                      </p>
                    ) : null}

                    <div className="option-list">
                      {visibleChoiceOptions.map((option, index) => (
                        <div key={index} className="option-item">
                          <label>
                            选项 {getOptionMarker(index, draft.optionStyle)}
                            <textarea
                              rows={2}
                              value={option}
                              onChange={(event) => updateChoiceOption(index, event.target.value)}
                              placeholder={`请输入选项 ${getOptionMarker(index, draft.optionStyle)}（支持 Markdown，允许换行）`}
                            />
                          </label>
                          <div className="tiny-preview">
                            <MarkdownRenderer value={option} />
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="answer-board">
                      <p>正确答案</p>
                      <div>
                        {visibleChoiceOptions.map((_item, index) => (
                          <label key={index}>
                            <input
                              type={draft.choiceMode === 'single' ? 'radio' : 'checkbox'}
                              checked={draft.choiceAnswers.includes(index)}
                              onChange={() => toggleChoiceAnswer(index)}
                            />
                            {getOptionMarker(index, draft.optionStyle)}
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="ai-line">
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={aiLoadingTarget !== null}
                        onClick={() => {
                          void generateAnalysisWithAI('choice')
                        }}
                      >
                        {aiLoadingTarget === 'choice' ? '生成中...' : 'AI 生成解析'}
                      </button>
                    </div>

                    <MarkdownEditor
                      label="解析"
                      value={draft.choiceAnalysis}
                      onChange={(value) =>
                        updateDraft('choiceAnalysis', normalizeMarkdownForEdit(value))
                      }
                      allowImages
                      onResolveImageDataUrl={rememberImageInMemory}
                      resolveMarkdownForPreview={resolveMarkdownForPreview}
                      minRows={6}
                      placeholder="可选。输入本题解析（Markdown/LaTeX）"
                    />
                  </section>
                ) : null}

                {draft.type === 'blank' ? (
                  <section className="section-block">
                    <h3>填空题参数</h3>
                    <p className="hint">
                      已识别空位：{detectedBlankCount} 个；实际按 {blankSlotCount} 个空位创建（若识别不到会自动在末尾补 1 个）。
                    </p>

                    <div className="blank-answer-list">
                      {Array.from({ length: blankSlotCount }).map((_, index) => (
                        <label key={index}>
                          第 {index + 1} 空答案
                          <textarea
                            rows={2}
                            value={draft.fillAnswers[index] ?? ''}
                            onChange={(event) => updateFillAnswer(index, event.target.value)}
                            placeholder={`第 ${index + 1} 空答案（Markdown/LaTeX）`}
                          />
                        </label>
                      ))}
                    </div>

                    {hiddenBlankDraftCount > 0 ? (
                      <p className="hint">
                        当前隐藏了 {hiddenBlankDraftCount} 个空位答案草稿，保存或放弃后会自动清理。
                      </p>
                    ) : null}

                    <div className="ai-line">
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={aiLoadingTarget !== null}
                        onClick={() => {
                          void generateAnalysisWithAI('blank')
                        }}
                      >
                        {aiLoadingTarget === 'blank' ? '生成中...' : 'AI 生成解析'}
                      </button>
                    </div>

                    <MarkdownEditor
                      label="解析"
                      value={draft.fillAnalysis}
                      onChange={(value) => updateDraft('fillAnalysis', normalizeMarkdownForEdit(value))}
                      allowImages
                      onResolveImageDataUrl={rememberImageInMemory}
                      resolveMarkdownForPreview={resolveMarkdownForPreview}
                      minRows={6}
                      placeholder="可手动输入解析，或点击 AI 生成。"
                    />
                  </section>
                ) : null}

                {draft.type === 'subjective' ? (
                  <section className="section-block">
                    <h3>主观题参数</h3>
                    <p className="hint">
                      已按连续换行、独立 ▲ 或已有空位标记识别答案区，共 {detectedSubjectiveBlankCount}{' '}
                      个；题面末尾
                      {subjectiveAppendedTrailingBlank ? '将自动补' : '已保留'}一个空位。
                    </p>

                    <div className="blank-answer-list">
                      {Array.from({ length: subjectiveSlotCount }).map((_, index) => (
                        <label key={index}>
                          第 {index + 1} 空答案
                          <textarea
                            rows={3}
                            value={draft.subjectiveAnswers[index] ?? ''}
                            onChange={(event) => updateSubjectiveAnswer(index, event.target.value)}
                            placeholder={`第 ${index + 1} 空答案（Markdown/LaTeX）`}
                          />
                        </label>
                      ))}
                    </div>

                    {hiddenSubjectiveDraftCount > 0 ? (
                      <p className="hint">
                        当前隐藏了 {hiddenSubjectiveDraftCount} 个答案草稿，保存或放弃后会自动清理。
                      </p>
                    ) : null}

                    <div className="ai-line">
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={aiLoadingTarget !== null}
                        onClick={() => {
                          void generateAnalysisWithAI('subjective')
                        }}
                      >
                        {aiLoadingTarget === 'subjective' ? '生成中...' : 'AI 生成解析'}
                      </button>
                    </div>

                    <MarkdownEditor
                      label="解析"
                      value={draft.subjectiveAnalysis}
                      onChange={(value) =>
                        updateDraft('subjectiveAnalysis', normalizeMarkdownForEdit(value))
                      }
                      allowImages
                      onResolveImageDataUrl={rememberImageInMemory}
                      resolveMarkdownForPreview={resolveMarkdownForPreview}
                      minRows={6}
                      placeholder="请输入解析（Markdown/LaTeX）"
                    />
                  </section>
                ) : null}

                <section className="subject-picker">
                  <p>最后确认学科</p>
                  <div className="subject-list">
                    {SUBJECTS.map((subject) => (
                      <button
                        key={subject.key}
                        type="button"
                        className={draft.subject === subject.key ? 'active' : ''}
                        style={
                          {
                            '--subject-color': subject.color,
                            '--subject-soft-color': subject.softColor,
                          } as CSSProperties
                        }
                        onClick={() => updateDraft('subject', subject.key)}
                      >
                        {subject.label}
                      </button>
                    ))}
                  </div>
                </section>

                <div className="bottom-actions">
                  <button type="button" className="primary-btn" onClick={submitQuestion}>
                    {isEditing ? '保存修改' : '创建题目'}
                  </button>
                  <button type="button" className="ghost-btn" onClick={clearDraft}>
                    {isEditing ? '取消编辑' : '放弃当前创建'}
                  </button>
                </div>
              </section>
            </section>
          ) : null}

          {currentTab === 'bank' ? (
            <section className="pane">
              <header className="pane-head">
                <h2>题库</h2>
                <p>默认展示当日日期，可按日期区间、学分、题型筛选。</p>
              </header>

              <div className="filters">
                <label>
                  起始日期
                  <input
                    type="date"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                  />
                </label>

                <label>
                  结束日期
                  <input
                    type="date"
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
                  />
                </label>

                <label>
                  学分
                  <select
                    value={bankCreditFilter}
                    onChange={(event) => setBankCreditFilter(event.target.value as CreditFilter)}
                  >
                    {(Object.keys(CREDIT_FILTER_LABEL) as CreditFilter[]).map((credit) => (
                      <option key={credit} value={credit}>
                        {CREDIT_FILTER_LABEL[credit]}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  题型
                  <select
                    value={bankTypeFilter}
                    onChange={(event) => setBankTypeFilter(event.target.value as TypeFilter)}
                  >
                    <option value="all">全部题型</option>
                    {(Object.keys(QUESTION_TYPE_LABEL) as QuestionType[]).map((type) => (
                      <option key={type} value={type}>
                        {QUESTION_TYPE_LABEL[type]}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    setStartDate(today)
                    setEndDate(today)
                  }}
                >
                  回到今日
                </button>

                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => void exportPdf('plain')}
                  disabled={pdfExporting}
                >
                  {pdfExporting && pdfExportingTarget === 'plain' ? '导出中...' : '导出题面 PDF'}
                </button>

                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => void exportPdf('analysis')}
                  disabled={pdfExporting}
                >
                  {pdfExporting && pdfExportingTarget === 'analysis'
                    ? '导出中...'
                    : '导出题面及答案 PDF'}
                </button>
              </div>

              <p className="hint">
                当前筛选日期区间：{dateRange.start} 至 {dateRange.end}，共 {bankList.length} 题。
              </p>

              <div className="question-list">
                {bankList.length === 0 ? <p className="empty">当前筛选下暂无题目。</p> : null}
                {bankRenderList.map(({ question, displayMarkdown, analysisMarkdown }) => (
                  <article
                    key={question.id}
                    className={question.id === editingQuestionId ? 'question-card is-editing' : 'question-card'}
                  >
                    <header>
                      <div className="question-meta">
                        <span
                          className="subject-pill"
                          style={{
                            backgroundColor: SUBJECT_MAP[question.subject].softColor,
                            color: SUBJECT_MAP[question.subject].color,
                          }}
                        >
                          {SUBJECT_MAP[question.subject].label}
                        </span>
                        <span>{QUESTION_TYPE_LABEL[question.type]}</span>
                        <span>{formatDateTime(question.createdAt)}</span>
                      </div>
                      <div className="card-actions">
                        <button type="button" className="ghost-btn" onClick={() => startEditQuestion(question)}>
                          编辑
                        </button>
                        <button type="button" className="ghost-btn danger" onClick={() => deleteQuestion(question.id)}>
                          删除
                        </button>
                      </div>
                    </header>

                    <MarkdownRenderer value={displayMarkdown} allowHtml />

                    {analysisMarkdown ? (
                      <div className="analysis-block">
                        <MarkdownRenderer value={analysisMarkdown} />
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {notice ? <div className="toast">{notice}</div> : null}
        </main>
      </div>
    </div>
  )
}

export default App
