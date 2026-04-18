import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import katex from 'katex'
import { useLocation, useNavigate } from 'react-router-dom'
import ExportConfigModal from './components/ExportConfigModal'
import MarkdownEditor from './components/MarkdownEditor'
import MarkdownRenderer from './components/MarkdownRenderer'
import RichPasteEditor from './components/RichPasteEditor'
import { SUBJECT_MAP, SUBJECTS } from './data/subjects'
import {
  DEFAULT_PDF_EXPORT_SPACING_CONFIG,
  loadPdfExportSpacingConfig,
  savePdfExportSpacingConfig,
  sanitizePdfExportSpacingConfig,
  type PdfExportSpacingConfig,
} from './lib/pdfExportConfig'
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
import {
  hasNoPanguMarker,
  prepareMarkdownForSubmission,
  stripNoPanguMarker,
} from './lib/markdownSpacing'
import type {
  AiSettings,
  ChoiceMode,
  ChoiceSubQuestion,
  OptionStyle,
  Question,
  QuestionType,
  SubjectKey,
} from './types'

type CreditFilter = 'all' | 'humanities' | 'science' | 'other'
type TypeFilter = QuestionType | 'all'
type AnalysisTarget = 'choice' | 'choiceGroup' | 'blank' | 'subjective'
type PdfExportTarget = 'plain' | 'analysis'
type CreateMode = 'manual' | 'quickImport'

interface DraftState {
  subject: SubjectKey
  type: QuestionType
  stem: string
  choiceMode: ChoiceMode
  optionStyle: OptionStyle
  optionCount: number
  options: string[]
  choiceAnswers: number[]
  choiceAnalysis: string
  choiceGroupQuestions: ChoiceSubQuestion[]
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

interface ParsedChoiceGroupAiItem {
  analysisMarkdown: string
  generatedAnswers: string[]
  answerReasonable: boolean | null
  reasonabilityComment: string
}

interface QuickImportChoiceSubquestionPayload {
  stemMarkdown: string
  analysisMarkdown: string
  choiceMode: ChoiceMode
  optionStyle: OptionStyle
  options: string[]
  correctAnswers: string[]
}

interface QuickImportQuestionPayload {
  type: QuestionType
  stemMarkdown: string
  analysisMarkdown: string
  choiceMode: ChoiceMode
  optionStyle: OptionStyle
  options: string[]
  correctAnswers: string[]
  answers: string[]
  subquestions: QuickImportChoiceSubquestionPayload[]
}

interface ParsedImageImportResponse {
  stemMarkdown: string
  options: string[]
}

type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
type ChatMessageContent = string | ChatContentPart[]

const QUESTIONS_KEY = 'mistakes.questions.v1'
const QUESTIONS_SNAPSHOT_LOCAL_STORAGE_KEY = 'mistakes.questions.snapshot.v1'
const LAST_CREATED_SUBJECT_KEY = 'mistakes.last-created-subject.v1'
const AI_SETTINGS_LOCAL_STORAGE_KEY = 'mistakes.ai-settings.snapshot.v1'
const QUESTIONS_CLOUD_URL = import.meta.env.VITE_QUESTIONS_URL?.trim() || '/api/questions'
const QUESTIONS_CLOUD_TOKEN =
  import.meta.env.VITE_QUESTIONS_TOKEN?.trim() || import.meta.env.VITE_AI_SETTINGS_TOKEN?.trim() || ''
const QUESTIONS_CLOUD_SAVE_METHOD =
  import.meta.env.VITE_QUESTIONS_SAVE_METHOD?.trim().toUpperCase() || 'PUT'
const AI_SETTINGS_CLOUD_URL = import.meta.env.VITE_AI_SETTINGS_URL?.trim() || '/api/ai-settings'
const AI_SETTINGS_CLOUD_TOKEN = import.meta.env.VITE_AI_SETTINGS_TOKEN?.trim() || ''
const AI_SETTINGS_CLOUD_SAVE_METHOD =
  import.meta.env.VITE_AI_SETTINGS_SAVE_METHOD?.trim().toUpperCase() || 'PUT'
const MCP_SERVER_URL = import.meta.env.VITE_MCP_URL?.trim() || '/api/mcp'
const MCP_SERVER_TOKEN = import.meta.env.VITE_MCP_TOKEN?.trim() || QUESTIONS_CLOUD_TOKEN

const INITIAL_AI_SETTINGS: AiSettings = {
  enabled: true,
  baseUrl: '',
  apiKey: '',
  model: '',
}

interface AiSettingsSnapshot {
  settings: AiSettings
  updatedAt: string
}

interface ComparableAiSettingsSnapshot {
  settings: AiSettings
  updatedAt: string | null
}

interface QuestionSnapshot {
  questions: Question[]
  updatedAt: string
}

interface ComparableQuestionSnapshot {
  questions: Question[]
  updatedAt: string | null
}

interface ParsedAiSettingsCloudPayload {
  exists: boolean
  snapshot: ComparableAiSettingsSnapshot | null
}

interface ParsedQuestionCloudPayload {
  exists: boolean
  snapshot: ComparableQuestionSnapshot | null
}

interface McpToolMetadata {
  name: string
  description: string
}

interface McpResourceMetadata {
  uri?: string
  uriTemplate?: string
  name: string
  description?: string
}

interface McpServerMetadata {
  name: string
  version: string
  protocol: string
  endpoint: string
  authRequired: boolean
  capabilities: {
    tools: McpToolMetadata[]
    staticResources: McpResourceMetadata[]
    resourceTemplates: McpResourceMetadata[]
  }
}

type QuestionStateUpdater = Question[] | ((prev: Question[]) => Question[])

const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  choice: '选择题',
  choiceGroup: '选择题（多空）',
  blank: '填空题',
  subjective: '主观题',
}

const PDF_EXPORT_TARGET_LABEL: Record<PdfExportTarget, string> = {
  plain: '题面 PDF',
  analysis: '题面及答案 PDF',
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

function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

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

function createChoiceSubQuestion(seed?: Partial<ChoiceSubQuestion>): ChoiceSubQuestion {
  const optionCount = Math.min(8, Math.max(2, Number(seed?.optionCount) || 4))
  const options = Array.isArray(seed?.options)
    ? ensureLength(
        seed.options.map((item) => String(item ?? '')),
        Math.max(8, optionCount),
      )
    : Array.from({ length: 8 }, () => '')

  const choiceMode = (seed?.choiceMode as ChoiceMode | undefined) ?? 'single'

  return {
    id: seed?.id ?? generateUuid(),
    stem: seed?.stem ?? '',
    normalizedStem: seed?.normalizedStem ?? '',
    choiceMode,
    optionStyle: (seed?.optionStyle as OptionStyle | undefined) ?? 'latin',
    optionCount,
    options,
    correctAnswers: sanitizeChoiceAnswers(choiceMode, seed?.correctAnswers ?? [], optionCount),
    analysis: seed?.analysis ?? '',
  }
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
  choiceGroupQuestions: [createChoiceSubQuestion()],
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

  if (question.type === 'choiceGroup') {
    return {
      ...createInitialDraft(),
      subject: question.subject,
      type: 'choiceGroup',
      stem: normalizeMarkdownForEdit(question.stem),
      choiceGroupQuestions:
        question.subquestions.length > 0
          ? question.subquestions.map((item) =>
              createChoiceSubQuestion({
                ...item,
                stem: normalizeMarkdownForEdit(item.stem),
                normalizedStem: normalizeMarkdownForEdit(item.normalizedStem),
                options: ensureLength(
                  item.options.map((option) => normalizeMarkdownForEdit(option)),
                  8,
                ),
                analysis: normalizeMarkdownForEdit(item.analysis),
              }),
            )
          : [createChoiceSubQuestion()],
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

function getOptionMarker(index: number, style: OptionStyle): string {
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

function normalizeAiSettings(raw: unknown): AiSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...INITIAL_AI_SETTINGS }
  }

  const source = raw as Record<string, unknown>
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

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  const timestamp = Date.parse(trimmed)
  if (Number.isNaN(timestamp)) {
    return null
  }

  return new Date(timestamp).toISOString()
}

function hasAiSettingsFields(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false
  }

  const source = value as Record<string, unknown>
  return 'enabled' in source || 'baseUrl' in source || 'apiKey' in source || 'model' in source
}

function parseAiSettingsSnapshotLike(payload: unknown): ComparableAiSettingsSnapshot | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const root = payload as Record<string, unknown>

  if (root.snapshot && typeof root.snapshot === 'object') {
    const parsed = parseAiSettingsSnapshotLike(root.snapshot)
    if (parsed) {
      return parsed
    }
  }

  if (root.data && typeof root.data === 'object') {
    const parsed = parseAiSettingsSnapshotLike(root.data)
    if (parsed) {
      return parsed
    }
  }

  if (root.settings && typeof root.settings === 'object') {
    const nestedSettings = root.settings as Record<string, unknown>
    if (hasAiSettingsFields(nestedSettings)) {
      return {
        settings: normalizeAiSettings(nestedSettings),
        updatedAt: normalizeTimestamp(root.updatedAt),
      }
    }

    const parsed = parseAiSettingsSnapshotLike(nestedSettings)
    if (parsed) {
      return parsed
    }
  }

  if (!hasAiSettingsFields(root)) {
    return null
  }

  return {
    settings: normalizeAiSettings(root),
    updatedAt: normalizeTimestamp(root.updatedAt),
  }
}

function parseAiSettingsCloudPayload(payload: unknown): ParsedAiSettingsCloudPayload | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const source = payload as Record<string, unknown>
  const snapshot = parseAiSettingsSnapshotLike(payload)
  const exists = typeof source.exists === 'boolean' ? source.exists : snapshot !== null
  return {
    exists,
    snapshot: exists ? snapshot : null,
  }
}

function loadAiSettingsSnapshotFromLocalStorage(): ComparableAiSettingsSnapshot | null {
  const cached = fromLocalStorage<unknown | null>(AI_SETTINGS_LOCAL_STORAGE_KEY, null)
  return parseAiSettingsSnapshotLike(cached)
}

function saveAiSettingsSnapshotToLocalStorage(snapshot: AiSettingsSnapshot): void {
  toLocalStorage(AI_SETTINGS_LOCAL_STORAGE_KEY, snapshot)
}

function materializeAiSettingsSnapshot(snapshot: ComparableAiSettingsSnapshot): AiSettingsSnapshot {
  return {
    settings: normalizeAiSettings(snapshot.settings),
    updatedAt: snapshot.updatedAt ?? new Date().toISOString(),
  }
}

function getAiSettingsSnapshotTime(snapshot: ComparableAiSettingsSnapshot | null): number {
  if (!snapshot?.updatedAt) {
    return Number.NEGATIVE_INFINITY
  }

  const timestamp = Date.parse(snapshot.updatedAt)
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp
}

function compareAiSettingsSnapshots(
  left: ComparableAiSettingsSnapshot | null,
  right: ComparableAiSettingsSnapshot | null,
): number {
  return getAiSettingsSnapshotTime(left) - getAiSettingsSnapshotTime(right)
}

function areAiSettingsEqual(left: AiSettings, right: AiSettings): boolean {
  return (
    left.enabled === right.enabled &&
    left.baseUrl === right.baseUrl &&
    left.apiKey === right.apiKey &&
    left.model === right.model
  )
}

function areAiSettingsSnapshotsEqual(
  left: ComparableAiSettingsSnapshot | null,
  right: ComparableAiSettingsSnapshot | null,
): boolean {
  if (!left || !right) {
    return left === right
  }

  return left.updatedAt === right.updatedAt && areAiSettingsEqual(left.settings, right.settings)
}

const INITIAL_LOCAL_AI_SETTINGS_SNAPSHOT =
  typeof window !== 'undefined' ? loadAiSettingsSnapshotFromLocalStorage() : null

function getPayloadMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const source = payload as Record<string, unknown>
  const direct = source.message
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct.trim()
  }
  const error = source.error
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim()
  }
  if (error && typeof error === 'object') {
    const nested = (error as Record<string, unknown>).message
    if (typeof nested === 'string' && nested.trim().length > 0) {
      return nested.trim()
    }
  }
  return null
}

async function parseCloudResponseJson(response: Response): Promise<unknown | null> {
  const raw = await response.text()
  const text = raw.trim()
  if (!text) {
    return null
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  const isHtmlFallback =
    contentType.includes('text/html') ||
    /^<!doctype html>/i.test(text) ||
    /^<html[\s>]/i.test(text)
  if (isHtmlFallback) {
    throw new Error('云端配置接口返回了 HTML 页面，请检查 `VITE_AI_SETTINGS_URL` 是否指向真实 API。')
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('云端配置接口返回了非 JSON 内容，请检查服务端返回格式。')
  }
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

function parseChoiceGroupAiResponse(raw: string, count: number): ParsedChoiceGroupAiItem[] | null {
  const candidate = extractJsonCandidate(raw)
  if (!candidate) {
    return null
  }

  const json = parseJsonCandidate(candidate)
  if (!json) {
    return null
  }

  const rootItems = Array.isArray(json.subquestions)
    ? json.subquestions
    : Array.isArray(json.questions)
      ? json.questions
      : Array.isArray(json.items)
        ? json.items
        : null

  if (!rootItems) {
    return null
  }

  const normalizedItems = rootItems
    .slice(0, count)
    .map((item): ParsedChoiceGroupAiItem | null => {
      if (!item || typeof item !== 'object') {
        return null
      }
      const source = item as Record<string, unknown>
      const analysisValue =
        (typeof source.analysis_markdown === 'string' && source.analysis_markdown) ||
        (typeof source.analysis === 'string' && source.analysis) ||
        (typeof source['解析'] === 'string' && (source['解析'] as string)) ||
        ''

      const generatedAnswers = normalizeToStringArray(
        source.generated_answers ?? source.answers ?? source['答案'] ?? source.suggested_answers,
      )

      const answerReasonableRaw =
        source.answer_reasonable ??
        source.is_reasonable ??
        source.reasonable ??
        source['答案是否合理']
      const answerReasonable =
        typeof answerReasonableRaw === 'boolean' ? answerReasonableRaw : null

      const reasonabilityComment =
        (typeof source.reasonability_comment === 'string' && source.reasonability_comment) ||
        (typeof source.reason === 'string' && source.reason) ||
        (typeof source.comment === 'string' && source.comment) ||
        ''

      return {
        analysisMarkdown: String(analysisValue || '').trim(),
        generatedAnswers,
        answerReasonable,
        reasonabilityComment,
      }
    })
    .filter((item): item is ParsedChoiceGroupAiItem => item !== null)

  return normalizedItems.length === count ? normalizedItems : null
}

function parseChoiceAnswerIndices(
  rawAnswers: string[],
  optionCount: number,
  optionStyle: OptionStyle,
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

function normalizeChoiceModeValue(value: unknown, answerCount = 0): ChoiceMode {
  const normalized =
    value === 'single' || value === 'double' || value === 'multiple'
      ? value
      : typeof value === 'string'
        ? value.toLowerCase().includes('double') || value.includes('双')
          ? 'double'
          : value.toLowerCase().includes('multiple') ||
              value.toLowerCase().includes('multi') ||
              value.includes('多') ||
              value.includes('不定')
            ? 'multiple'
            : 'single'
        : 'single'

  if (answerCount <= 1) {
    return 'single'
  }
  if (answerCount === 2) {
    return normalized === 'multiple' ? 'multiple' : 'double'
  }
  return 'multiple'
}

function normalizeOptionStyleValue(value: unknown): OptionStyle {
  if (value === 'circle' || value === 'latin') {
    return value
  }

  if (typeof value === 'string' && (value.includes('①') || value.includes('circle') || value.includes('数字'))) {
    return 'circle'
  }

  return 'latin'
}

function stripLeadingOptionMarker(value: string): string {
  return value
    .replace(/^\s*(?:[A-Ha-h][.)．、:：]|\d+[.)．、:：]|[①②③④⑤⑥⑦⑧⑨⑩][.)．、:：]?|\(\d+\))\s*/, '')
    .trim()
}

function normalizeMarkdownImagePlaceholders(markdown: string): string[] {
  const regex = new RegExp(MARKDOWN_IMAGE_REGEX.source, 'g')
  return Array.from(markdown.matchAll(regex), (match) => match[0])
}

function buildQuickImportUserMessageContent(
  prompt: string,
  markdown: string,
  imageMemory: Record<string, string>,
): ChatMessageContent {
  if (!markdown.includes('![') || !markdown.includes('(')) {
    return `${prompt}${markdown}`
  }

  const imageRegex = new RegExp(MARKDOWN_IMAGE_REGEX.source, 'g')
  const parts: ChatContentPart[] = []
  pushTextPart(parts, prompt)
  let cursor = 0

  for (const match of markdown.matchAll(imageRegex)) {
    const index = match.index ?? 0
    const full = match[0]
    const url = match[2] ?? ''

    pushTextPart(parts, markdown.slice(cursor, index))
    pushTextPart(parts, `${full}\n`)

    const resolvedUrl = resolveImageUrlForAi(url, imageMemory)
    if (resolvedUrl) {
      parts.push({
        type: 'image_url',
        image_url: {
          url: resolvedUrl,
        },
      })
      pushTextPart(parts, '\n')
    }

    cursor = index + full.length
  }

  pushTextPart(parts, markdown.slice(cursor))
  return parts
}

function parseQuickImportAiResponse(raw: string): QuickImportQuestionPayload[] | null {
  const candidate = extractJsonCandidate(raw)
  if (!candidate) {
    return null
  }

  const json = parseJsonCandidate(candidate)
  if (!json) {
    return null
  }

  const rootItems = Array.isArray(json.questions)
    ? json.questions
    : Array.isArray(json.items)
      ? json.items
      : Array.isArray(json.data)
        ? json.data
        : null

  if (!rootItems) {
    return null
  }

  return rootItems
    .map((item): QuickImportQuestionPayload | null => {
      if (!item || typeof item !== 'object') {
        return null
      }

      const source = item as Record<string, unknown>
      const rawType = String(source.type ?? source.question_type ?? source['题型'] ?? 'subjective')
      const type: QuestionType =
        rawType === 'choice' ||
        rawType === 'choiceGroup' ||
        rawType === 'blank' ||
        rawType === 'subjective'
          ? rawType
          : rawType.includes('多空') || rawType.includes('组合')
            ? 'choiceGroup'
            : rawType.includes('选择')
              ? 'choice'
              : rawType.includes('填空')
                ? 'blank'
                : 'subjective'

      const stemMarkdown = String(
        source.stem_markdown ?? source.stem ?? source.question_markdown ?? source['题面'] ?? '',
      ).trim()
      const analysisMarkdown = String(
        source.analysis_markdown ?? source.analysis ?? source['解析'] ?? '',
      ).trim()
      const options = normalizeToStringArray(source.options ?? source.option_markdown ?? source['选项']).map(
        stripLeadingOptionMarker,
      )
      const correctAnswers =
        type === 'choice' || type === 'choiceGroup'
          ? normalizeToStringArray(
              source.correct_answers ?? source.answer_keys ?? source.answers ?? source['答案'],
            )
          : []
      const answers =
        type === 'blank' || type === 'subjective'
          ? normalizeToStringArray(
              source.answers ??
                source.answer_markdown ??
                source.reference_answers ??
                source['参考答案'] ??
                source.blank_answers ??
                source['答案'],
            )
          : normalizeToStringArray(
              source.answer_markdown ?? source.reference_answers ?? source['参考答案'] ?? source.blank_answers,
            )

      const subquestionsSource = Array.isArray(source.subquestions)
        ? source.subquestions
        : Array.isArray(source.questions)
          ? source.questions
          : []

      const subquestions = subquestionsSource
        .map((subquestion): QuickImportChoiceSubquestionPayload | null => {
          if (!subquestion || typeof subquestion !== 'object') {
            return null
          }

          const subSource = subquestion as Record<string, unknown>
          const subCorrectAnswers = normalizeToStringArray(
            subSource.correct_answers ?? subSource.answers ?? subSource.answer_keys ?? subSource['答案'],
          )

          return {
            stemMarkdown: String(
              subSource.stem_markdown ?? subSource.stem ?? subSource.question_markdown ?? subSource['题面'] ?? '',
            ).trim(),
            analysisMarkdown: String(
              subSource.analysis_markdown ?? subSource.analysis ?? subSource['解析'] ?? '',
            ).trim(),
            choiceMode: normalizeChoiceModeValue(
              subSource.choice_mode ?? subSource.mode ?? subSource['子类型'],
              subCorrectAnswers.length,
            ),
            optionStyle: normalizeOptionStyleValue(
              subSource.option_style ?? subSource['选项风格'],
            ),
            options: normalizeToStringArray(subSource.options ?? subSource.option_markdown ?? subSource['选项']).map(
              stripLeadingOptionMarker,
            ),
            correctAnswers: subCorrectAnswers,
          }
        })
        .filter((subquestion): subquestion is QuickImportChoiceSubquestionPayload => subquestion !== null)

      return {
        type,
        stemMarkdown,
        analysisMarkdown,
        choiceMode: normalizeChoiceModeValue(source.choice_mode ?? source.mode ?? source['子类型'], correctAnswers.length),
        optionStyle: normalizeOptionStyleValue(source.option_style ?? source['选项风格']),
        options,
        correctAnswers,
        answers,
        subquestions,
      }
    })
    .filter((item): item is QuickImportQuestionPayload => item !== null)
}

function parseImageImportAiResponse(raw: string): ParsedImageImportResponse | null {
  const candidate = extractJsonCandidate(raw)
  if (!candidate) {
    const fallback = raw.trim()
    return fallback
      ? {
          stemMarkdown: fallback,
          options: [],
        }
      : null
  }

  const json = parseJsonCandidate(candidate)
  if (!json) {
    const fallback = raw.trim()
    return fallback
      ? {
          stemMarkdown: fallback,
          options: [],
        }
      : null
  }

  const stemMarkdown = String(
    json.stem_markdown ?? json.stem ?? json.question_markdown ?? json.text ?? json['题面'] ?? '',
  ).trim()
  const options = normalizeToStringArray(json.options ?? json.option_markdown ?? json['选项']).map(
    stripLeadingOptionMarker,
  )

  if (!stemMarkdown && options.length === 0) {
    return null
  }

  return {
    stemMarkdown,
    options,
  }
}

function buildChoiceDisplayMarkdown(question: Extract<Question, { type: 'choice' }>): string {
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

function buildChoiceGroupDisplayMarkdown(question: Extract<Question, { type: 'choiceGroup' }>): string {
  const sections = question.subquestions.map((subquestion, index) => {
    const stemBase = migrateStemTokens(subquestion.normalizedStem)
    const stemWithToken =
      countInlineTokens(stemBase) > 0 ? stemBase : `${stemBase.trimEnd()} [[INLINE_BLANK_1]]`.trim()
    const answerText = subquestion.correctAnswers
      .map((answerIndex) => getOptionMarker(answerIndex, subquestion.optionStyle))
      .join('、')
    const filledStem = replaceInlineBlanksWithValues(stemWithToken, [answerText])
    const optionLines = subquestion.options
      .slice(0, subquestion.optionCount)
      .map(
        (option, optionIndex) =>
          `**${getOptionMarker(optionIndex, subquestion.optionStyle)}** ${flattenOptionText(option)}`,
      )
      .join('\n\n')

    return [`### 第 ${index + 1} 题`, filledStem, optionLines].filter(Boolean).join('\n\n')
  })

  if (question.stem.trim().length === 0) {
    return sections.join('\n\n---\n\n')
  }

  return ['**共享材料**', question.stem, ...sections].join('\n\n')
}

function buildBlankDisplayMarkdown(question: Extract<Question, { type: 'blank' }>): string {
  const stemBase = migrateStemTokens(question.normalizedStem)
  const stemWithToken =
    countInlineTokens(stemBase) > 0 ? stemBase : `${stemBase.trimEnd()} [[INLINE_BLANK_1]]`.trim()
  return replaceInlineBlanksWithValues(stemWithToken, question.answers)
}

function buildSubjectiveDisplayMarkdown(question: Extract<Question, { type: 'subjective' }>): string {
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
  if (question.type === 'choiceGroup') return buildChoiceGroupDisplayMarkdown(question)
  if (question.type === 'blank') return buildBlankDisplayMarkdown(question)
  return buildSubjectiveDisplayMarkdown(question)
}

function buildQuestionAnalysisMarkdown(question: Question): string {
  if (question.type === 'choiceGroup') {
    return question.subquestions
      .map((subquestion, index) => {
        const analysis = subquestion.analysis.trim()
        if (!analysis) {
          return ''
        }
        return `### 第 ${index + 1} 题解析\n\n${analysis}`
      })
      .filter(Boolean)
      .join('\n\n---\n\n')
  }

  return 'analysis' in question ? question.analysis : ''
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
        id: String(item.id ?? generateUuid()),
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

      if (type === 'choiceGroup') {
        const rawSubquestions = Array.isArray(item.subquestions) ? item.subquestions : []
        const subquestions = rawSubquestions
          .map((rawSubquestion) => {
            if (!rawSubquestion || typeof rawSubquestion !== 'object') {
              return null
            }

            const subItem = rawSubquestion as Record<string, unknown>
            const rawNormalized = migrateStemTokens(
              String(subItem.normalizedStem ?? subItem.stem ?? ''),
            )
            const normalizedStem =
              countInlineTokens(rawNormalized) > 0
                ? rawNormalized
                : `${rawNormalized.trimEnd()} [[INLINE_BLANK_1]]`.trim()

            const options = Array.isArray(subItem.options)
              ? subItem.options.map((value) => String(value ?? ''))
              : []

            const optionCount = Number(subItem.optionCount ?? options.length ?? 4)
            const correctedOptionCount = Math.min(8, Math.max(2, optionCount || 4))
            const paddedOptions = ensureLength(options, Math.max(8, correctedOptionCount))

            const answers = Array.isArray(subItem.correctAnswers)
              ? subItem.correctAnswers
                  .map((value) => Number(value))
                  .filter((value) => Number.isFinite(value))
              : []

            const choiceMode = (subItem.choiceMode as ChoiceMode) ?? 'single'
            return createChoiceSubQuestion({
              id: String(subItem.id ?? generateUuid()),
              stem: String(subItem.stem ?? ''),
              normalizedStem,
              choiceMode,
              optionStyle: (subItem.optionStyle as OptionStyle) ?? 'latin',
              optionCount: correctedOptionCount,
              options: paddedOptions,
              correctAnswers: sanitizeChoiceAnswers(choiceMode, answers, correctedOptionCount),
              analysis: String(subItem.analysis ?? ''),
            })
          })
          .filter((subquestion): subquestion is ChoiceSubQuestion => subquestion !== null)

        return {
          ...base,
          type: 'choiceGroup' as const,
          normalizedStem: String(item.normalizedStem ?? item.stem ?? ''),
          subquestions: subquestions.length > 0 ? subquestions : [createChoiceSubQuestion()],
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

function parseQuestionsSnapshotLike(payload: unknown): ComparableQuestionSnapshot | null {
  if (Array.isArray(payload)) {
    return {
      questions: hydrateQuestions(payload),
      updatedAt: null,
    }
  }

  if (!payload || typeof payload !== 'object') {
    return null
  }

  const root = payload as Record<string, unknown>

  if (root.snapshot && typeof root.snapshot === 'object') {
    const parsed = parseQuestionsSnapshotLike(root.snapshot)
    if (parsed) {
      return parsed
    }
  }

  if (root.data && typeof root.data === 'object') {
    const parsed = parseQuestionsSnapshotLike(root.data)
    if (parsed) {
      return parsed
    }
  }

  if (Array.isArray(root.questions)) {
    return {
      questions: hydrateQuestions(root.questions),
      updatedAt: normalizeTimestamp(root.updatedAt),
    }
  }

  return null
}

function parseQuestionsCloudPayload(payload: unknown): ParsedQuestionCloudPayload | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const source = payload as Record<string, unknown>
  const snapshot = parseQuestionsSnapshotLike(payload)
  const exists = typeof source.exists === 'boolean' ? source.exists : snapshot !== null
  return {
    exists,
    snapshot: exists ? snapshot : null,
  }
}

function loadQuestionSnapshotFromLocalStorage(): ComparableQuestionSnapshot | null {
  const cachedSnapshot = fromLocalStorage<unknown | null>(QUESTIONS_SNAPSHOT_LOCAL_STORAGE_KEY, null)
  const parsedSnapshot = parseQuestionsSnapshotLike(cachedSnapshot)
  if (parsedSnapshot) {
    return parsedSnapshot
  }

  const cachedQuestions = fromLocalStorage<unknown | null>(QUESTIONS_KEY, null)
  return parseQuestionsSnapshotLike(cachedQuestions)
}

function saveQuestionSnapshotToLocalStorage(snapshot: QuestionSnapshot): void {
  toLocalStorage(QUESTIONS_KEY, snapshot.questions)
  toLocalStorage(QUESTIONS_SNAPSHOT_LOCAL_STORAGE_KEY, snapshot)
}

function materializeQuestionSnapshot(snapshot: ComparableQuestionSnapshot): QuestionSnapshot {
  return {
    questions: hydrateQuestions(snapshot.questions),
    updatedAt: snapshot.updatedAt ?? new Date().toISOString(),
  }
}

function getQuestionSnapshotTime(snapshot: ComparableQuestionSnapshot | null): number {
  if (!snapshot?.updatedAt) {
    return Number.NEGATIVE_INFINITY
  }

  const timestamp = Date.parse(snapshot.updatedAt)
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp
}

function compareQuestionSnapshots(
  left: ComparableQuestionSnapshot | null,
  right: ComparableQuestionSnapshot | null,
): number {
  return getQuestionSnapshotTime(left) - getQuestionSnapshotTime(right)
}

function serializeQuestionSnapshot(snapshot: ComparableQuestionSnapshot | null): string | null {
  if (!snapshot) {
    return null
  }

  return JSON.stringify({
    updatedAt: snapshot.updatedAt ?? null,
    questions: snapshot.questions,
  })
}

function areQuestionSnapshotsEqual(
  left: ComparableQuestionSnapshot | null,
  right: ComparableQuestionSnapshot | null,
): boolean {
  return serializeQuestionSnapshot(left) === serializeQuestionSnapshot(right)
}

function parseMcpServerMetadata(payload: unknown): McpServerMetadata | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const source = payload as Record<string, unknown>
  const capabilitiesSource =
    source.capabilities && typeof source.capabilities === 'object'
      ? (source.capabilities as Record<string, unknown>)
      : null

  const tools = Array.isArray(capabilitiesSource?.tools)
    ? capabilitiesSource.tools
        .map((item) => {
          if (!item || typeof item !== 'object') {
            return null
          }
          const tool = item as Record<string, unknown>
          return {
            name: typeof tool.name === 'string' ? tool.name : '',
            description: typeof tool.description === 'string' ? tool.description : '',
          }
        })
        .filter((item): item is McpToolMetadata => item !== null && item.name.length > 0)
    : []

  const parseResourceList = (value: unknown): McpResourceMetadata[] => {
    if (!Array.isArray(value)) {
      return []
    }

    const items: Array<McpResourceMetadata | null> = value.map((item) => {
      if (!item || typeof item !== 'object') {
        return null
      }

      const resource = item as Record<string, unknown>
      const name = typeof resource.name === 'string' ? resource.name : ''
      if (!name) {
        return null
      }

      return {
        name,
        description: typeof resource.description === 'string' ? resource.description : undefined,
        uri: typeof resource.uri === 'string' ? resource.uri : undefined,
        uriTemplate: typeof resource.uriTemplate === 'string' ? resource.uriTemplate : undefined,
      }
    })

    return items.filter((item): item is McpResourceMetadata => item !== null)
  }

  return {
    name: typeof source.name === 'string' ? source.name : 'correct-mcp',
    version: typeof source.version === 'string' ? source.version : 'unknown',
    protocol: typeof source.protocol === 'string' ? source.protocol : 'MCP',
    endpoint: typeof source.endpoint === 'string' ? source.endpoint : MCP_SERVER_URL,
    authRequired: Boolean(source.authRequired),
    capabilities: {
      tools,
      staticResources: parseResourceList(capabilitiesSource?.staticResources),
      resourceTemplates: parseResourceList(capabilitiesSource?.resourceTemplates),
    },
  }
}

const INITIAL_LOCAL_QUESTION_SNAPSHOT =
  typeof window !== 'undefined' ? loadQuestionSnapshotFromLocalStorage() : null

function App() {
  const today = getTodayDateKey()
  const location = useLocation()
  const navigate = useNavigate()

  const [settings, setSettings] = useState<AiSettings>(
    INITIAL_LOCAL_AI_SETTINGS_SNAPSHOT?.settings ?? INITIAL_AI_SETTINGS,
  )
  const [aiSettingsLoaded, setAiSettingsLoaded] = useState(false)
  const [aiSettingsSyncing, setAiSettingsSyncing] = useState(false)
  const [aiSettingsSaving, setAiSettingsSaving] = useState(false)
  const [aiSettingsSyncedAt, setAiSettingsSyncedAt] = useState<string | null>(
    INITIAL_LOCAL_AI_SETTINGS_SNAPSHOT?.updatedAt ?? null,
  )
  const [questions, setQuestions] = useState<Question[]>(() =>
    INITIAL_LOCAL_QUESTION_SNAPSHOT?.questions ?? hydrateQuestions(fromLocalStorage(QUESTIONS_KEY, [])),
  )
  const [questionsLoaded, setQuestionsLoaded] = useState(false)
  const [questionsSyncing, setQuestionsSyncing] = useState(false)
  const [questionsSaving, setQuestionsSaving] = useState(false)
  const [questionsSyncedAt, setQuestionsSyncedAt] = useState<string | null>(
    INITIAL_LOCAL_QUESTION_SNAPSHOT?.updatedAt ?? null,
  )
  const [draft, setDraft] = useState<DraftState>(() => ({
    ...createInitialDraft(),
    subject: getLastCreatedSubject(),
  }))
  const [createMode, setCreateMode] = useState<CreateMode>('manual')
  const [quickImportHtml, setQuickImportHtml] = useState('')
  const [quickImportMarkdown, setQuickImportMarkdown] = useState('')
  const [quickImportSubmitting, setQuickImportSubmitting] = useState(false)
  const [singleImageImporting, setSingleImageImporting] = useState(false)
  const [notice, setNotice] = useState('')
  const [aiLoadingTarget, setAiLoadingTarget] = useState<AnalysisTarget | null>(null)
  const [pdfExporting, setPdfExporting] = useState(false)
  const [pdfExportingTarget, setPdfExportingTarget] = useState<PdfExportTarget | null>(null)
  const [pdfExportDialogTarget, setPdfExportDialogTarget] = useState<PdfExportTarget | null>(null)
  const [pdfExportConfig, setPdfExportConfig] = useState<PdfExportSpacingConfig>(() =>
    loadPdfExportSpacingConfig(),
  )

  const [bankCreditFilter, setBankCreditFilter] = useState<CreditFilter>('all')
  const [bankTypeFilter, setBankTypeFilter] = useState<TypeFilter>('all')
  const [startDate, setStartDate] = useState(today)
  const [endDate, setEndDate] = useState(today)
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(null)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mcpMetadata, setMcpMetadata] = useState<McpServerMetadata | null>(null)
  const [mcpMetadataLoading, setMcpMetadataLoading] = useState(false)

  const imageMemoryRef = useRef<Record<string, string>>({})
  const imageIdByDataUrlRef = useRef<Record<string, string>>({})
  const blobUrlByDataUrlRef = useRef<Record<string, string>>({})
  const imageIndexRef = useRef(1)
  const singleImageImportInputRef = useRef<HTMLInputElement>(null)
  const draftTypeRef = useRef<QuestionType>(draft.type)
  const questionCloudSnapshotRef = useRef<string | null>(
    serializeQuestionSnapshot(INITIAL_LOCAL_QUESTION_SNAPSHOT),
  )

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
      const sanitizedValue = stripNoPanguMarker(value)
      if (!sanitizedValue.includes('![')) {
        return sanitizedValue
      }
      if (!sanitizedValue.includes('image_') && !sanitizedValue.includes('data:image/')) {
        return sanitizedValue
      }

      return sanitizedValue.replace(
        MARKDOWN_IMAGE_REGEX,
        (full, alt: string, url: string, title?: string) => {
          const normalizedUrl = url.trim()
          const resolvedUrl = resolveImageUrlForRender(normalizedUrl)
          if (resolvedUrl === normalizedUrl) {
            return full
          }
          const suffix = typeof title === 'string' ? title : ''
          return `![${alt}](${resolvedUrl}${suffix})`
        },
      )
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

  const materializeMarkdownForStorage = useCallback(
    (value: string, options?: { disableAutoSpacing?: boolean }): string => {
      const prepared = prepareMarkdownForSubmission(value, options)
      return materializeImageIds(prepared, imageMemoryRef.current)
    },
    [],
  )

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
    async (showSuccessNotice = false, showErrorNotice = true) => {
      setAiSettingsSyncing(true)
      const localSnapshot = loadAiSettingsSnapshotFromLocalStorage()
      try {
        const headers: HeadersInit = {}
        if (AI_SETTINGS_CLOUD_TOKEN) {
          headers.Authorization = `Bearer ${AI_SETTINGS_CLOUD_TOKEN}`
        }

        const response = await fetch(AI_SETTINGS_CLOUD_URL, {
          method: 'GET',
          headers,
        })
        const payload = await parseCloudResponseJson(response)
        if (!response.ok) {
          const detail = getPayloadMessage(payload)
          throw new Error(detail || `云端配置拉取失败（HTTP ${response.status}）`)
        }

        const parsed = parseAiSettingsCloudPayload(payload)
        if (!parsed) {
          throw new Error('云端配置格式错误，请检查接口返回。')
        }

        const cloudSnapshot = parsed.snapshot
        const chosenSnapshotSource =
          localSnapshot && cloudSnapshot
            ? compareAiSettingsSnapshots(localSnapshot, cloudSnapshot) > 0
              ? localSnapshot
              : cloudSnapshot
            : localSnapshot ?? cloudSnapshot

        const resolvedSnapshot = chosenSnapshotSource ? materializeAiSettingsSnapshot(chosenSnapshotSource) : null
        const localNeedsSync =
          resolvedSnapshot !== null && !areAiSettingsSnapshotsEqual(localSnapshot, resolvedSnapshot)
        const cloudNeedsSync =
          resolvedSnapshot !== null && (!parsed.exists || !areAiSettingsSnapshotsEqual(cloudSnapshot, resolvedSnapshot))

        let finalSnapshot = resolvedSnapshot
        if (resolvedSnapshot && cloudNeedsSync) {
          const syncHeaders: HeadersInit = {
            'Content-Type': 'application/json',
          }
          if (AI_SETTINGS_CLOUD_TOKEN) {
            syncHeaders.Authorization = `Bearer ${AI_SETTINGS_CLOUD_TOKEN}`
          }

          const saveResponse = await fetch(AI_SETTINGS_CLOUD_URL, {
            method: AI_SETTINGS_CLOUD_SAVE_METHOD,
            headers: syncHeaders,
            body: JSON.stringify(resolvedSnapshot),
          })
          const savePayload = await parseCloudResponseJson(saveResponse)
          if (!saveResponse.ok) {
            const detail = getPayloadMessage(savePayload)
            throw new Error(detail || `云端配置保存失败（HTTP ${saveResponse.status}）`)
          }

          const saved = parseAiSettingsCloudPayload(savePayload)
          if (!saved?.snapshot) {
            throw new Error('云端配置保存后返回格式错误，请检查接口返回。')
          }

          finalSnapshot = materializeAiSettingsSnapshot(saved.snapshot)
        }

        if (finalSnapshot && (localNeedsSync || cloudNeedsSync)) {
          saveAiSettingsSnapshotToLocalStorage(finalSnapshot)
        }

        setSettings(finalSnapshot?.settings ?? INITIAL_AI_SETTINGS)
        setAiSettingsSyncedAt(finalSnapshot?.updatedAt ?? null)
        if (showSuccessNotice) {
          if (finalSnapshot && cloudNeedsSync && !parsed.exists) {
            setNotice('检测到云端缺失，已用本地配置自动修复并同步。')
          } else if (finalSnapshot && cloudNeedsSync) {
            setNotice('已按较新版本完成 AI 配置双向同步。')
          } else if (finalSnapshot && localNeedsSync) {
            setNotice('已从云端同步 AI 配置并写入本地缓存。')
          } else {
            setNotice('已从云端同步 AI 配置。')
          }
        }
      } catch (error) {
        if (localSnapshot) {
          const fallbackSnapshot = materializeAiSettingsSnapshot(localSnapshot)
          saveAiSettingsSnapshotToLocalStorage(fallbackSnapshot)
          setSettings(fallbackSnapshot.settings)
          setAiSettingsSyncedAt(fallbackSnapshot.updatedAt)
        }
        if (showErrorNotice) {
          const message = error instanceof Error ? error.message : '云端配置拉取失败'
          setNotice(localSnapshot ? `${message}，已回退到本地配置。` : message)
        }
      } finally {
        setAiSettingsSyncing(false)
        setAiSettingsLoaded(true)
      }
    },
    [],
  )

  const saveAiSettingsToCloud = useCallback(async () => {
    setAiSettingsSaving(true)
    try {
      const nextSnapshot: AiSettingsSnapshot = {
        settings: {
          enabled: settings.enabled,
          baseUrl: settings.baseUrl.trim(),
          apiKey: settings.apiKey.trim(),
          model: settings.model.trim(),
        },
        updatedAt: new Date().toISOString(),
      }
      saveAiSettingsSnapshotToLocalStorage(nextSnapshot)
      setSettings(nextSnapshot.settings)
      setAiSettingsSyncedAt(nextSnapshot.updatedAt)

      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      }
      if (AI_SETTINGS_CLOUD_TOKEN) {
        headers.Authorization = `Bearer ${AI_SETTINGS_CLOUD_TOKEN}`
      }

      const response = await fetch(AI_SETTINGS_CLOUD_URL, {
        method: AI_SETTINGS_CLOUD_SAVE_METHOD,
        headers,
        body: JSON.stringify(nextSnapshot),
      })

      const payload = await parseCloudResponseJson(response)
      if (!response.ok) {
        const detail = getPayloadMessage(payload)
        throw new Error(detail || `云端配置保存失败（HTTP ${response.status}）`)
      }

      const parsed = parseAiSettingsCloudPayload(payload)
      const savedSnapshot = parsed?.snapshot ? materializeAiSettingsSnapshot(parsed.snapshot) : nextSnapshot
      saveAiSettingsSnapshotToLocalStorage(savedSnapshot)
      setSettings(savedSnapshot.settings)
      setAiSettingsSyncedAt(savedSnapshot.updatedAt)
      setNotice('AI 配置已同步到云端和本地缓存。')
    } catch (error) {
      const message = error instanceof Error ? error.message : '云端配置保存失败'
      setNotice(`${message}，新配置已保存在本地缓存，稍后会自动回补云端。`)
    } finally {
      setAiSettingsSaving(false)
      setAiSettingsLoaded(true)
    }
  }, [settings])

  const updateQuestions = useCallback((updater: QuestionStateUpdater) => {
    const updatedAt = new Date().toISOString()
    setQuestions((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      return hydrateQuestions(next)
    })
    setQuestionsSyncedAt(updatedAt)
  }, [])

  const syncQuestionsFromCloud = useCallback(
    async (showSuccessNotice = false, showErrorNotice = true) => {
      setQuestionsSyncing(true)
      const localSnapshot = loadQuestionSnapshotFromLocalStorage()

      try {
        const headers: HeadersInit = {}
        if (QUESTIONS_CLOUD_TOKEN) {
          headers.Authorization = `Bearer ${QUESTIONS_CLOUD_TOKEN}`
        }

        const response = await fetch(QUESTIONS_CLOUD_URL, {
          method: 'GET',
          headers,
        })
        const payload = await parseCloudResponseJson(response)
        if (!response.ok) {
          const detail = getPayloadMessage(payload)
          throw new Error(detail || `题库云端拉取失败（HTTP ${response.status}）`)
        }

        const parsed = parseQuestionsCloudPayload(payload)
        if (!parsed) {
          throw new Error('题库云端返回格式错误，请检查接口返回。')
        }

        const cloudSnapshot = parsed.snapshot
        const chosenSnapshotSource =
          localSnapshot && cloudSnapshot
            ? compareQuestionSnapshots(localSnapshot, cloudSnapshot) > 0
              ? localSnapshot
              : cloudSnapshot
            : localSnapshot ?? cloudSnapshot

        const resolvedSnapshot = chosenSnapshotSource ? materializeQuestionSnapshot(chosenSnapshotSource) : null
        const localNeedsSync =
          resolvedSnapshot !== null && !areQuestionSnapshotsEqual(localSnapshot, resolvedSnapshot)
        const cloudNeedsSync =
          resolvedSnapshot !== null && (!parsed.exists || !areQuestionSnapshotsEqual(cloudSnapshot, resolvedSnapshot))

        let finalSnapshot = resolvedSnapshot
        if (resolvedSnapshot && cloudNeedsSync) {
          const syncHeaders: HeadersInit = {
            'Content-Type': 'application/json',
          }
          if (QUESTIONS_CLOUD_TOKEN) {
            syncHeaders.Authorization = `Bearer ${QUESTIONS_CLOUD_TOKEN}`
          }

          const saveResponse = await fetch(QUESTIONS_CLOUD_URL, {
            method: QUESTIONS_CLOUD_SAVE_METHOD,
            headers: syncHeaders,
            body: JSON.stringify(resolvedSnapshot),
          })
          const savePayload = await parseCloudResponseJson(saveResponse)
          if (!saveResponse.ok) {
            const detail = getPayloadMessage(savePayload)
            throw new Error(detail || `题库云端保存失败（HTTP ${saveResponse.status}）`)
          }

          const saved = parseQuestionsCloudPayload(savePayload)
          if (!saved?.snapshot) {
            throw new Error('题库云端保存后返回格式错误，请检查接口返回。')
          }

          finalSnapshot = materializeQuestionSnapshot(saved.snapshot)
        }

        if (finalSnapshot && (localNeedsSync || cloudNeedsSync)) {
          saveQuestionSnapshotToLocalStorage(finalSnapshot)
        }

        questionCloudSnapshotRef.current = serializeQuestionSnapshot(finalSnapshot)
        setQuestions(finalSnapshot?.questions ?? [])
        setQuestionsSyncedAt(finalSnapshot?.updatedAt ?? null)

        if (showSuccessNotice) {
          if (finalSnapshot && cloudNeedsSync && !parsed.exists) {
            setNotice('检测到云端题库缺失，已用本地版本自动修复并同步。')
          } else if (finalSnapshot && cloudNeedsSync) {
            setNotice('已按较新版本完成题库双向同步。')
          } else if (finalSnapshot && localNeedsSync) {
            setNotice('已从云端同步题库并写入本地缓存。')
          } else {
            setNotice('已从云端同步题库。')
          }
        }
      } catch (error) {
        if (localSnapshot) {
          const fallbackSnapshot = materializeQuestionSnapshot(localSnapshot)
          saveQuestionSnapshotToLocalStorage(fallbackSnapshot)
          questionCloudSnapshotRef.current = serializeQuestionSnapshot(fallbackSnapshot)
          setQuestions(fallbackSnapshot.questions)
          setQuestionsSyncedAt(fallbackSnapshot.updatedAt)
        }

        if (showErrorNotice) {
          const message = error instanceof Error ? error.message : '题库云端拉取失败'
          setNotice(localSnapshot ? `${message}，已回退到本地题库。` : message)
        }
      } finally {
        setQuestionsSyncing(false)
        setQuestionsLoaded(true)
      }
    },
    [],
  )

  const fetchMcpMetadata = useCallback(
    async (showSuccessNotice = false, showErrorNotice = false) => {
      setMcpMetadataLoading(true)

      try {
        const headers: HeadersInit = {}
        if (MCP_SERVER_TOKEN) {
          headers.Authorization = `Bearer ${MCP_SERVER_TOKEN}`
        }

        const response = await fetch(MCP_SERVER_URL, {
          method: 'GET',
          headers,
        })
        const payload = await parseCloudResponseJson(response)
        if (!response.ok) {
          const detail = getPayloadMessage(payload)
          throw new Error(detail || `MCP 信息读取失败（HTTP ${response.status}）`)
        }

        const parsed = parseMcpServerMetadata(payload)
        if (!parsed) {
          throw new Error('MCP 服务返回格式错误。')
        }

        setMcpMetadata(parsed)
        if (showSuccessNotice) {
          setNotice('MCP 接入信息已刷新。')
        }
      } catch (error) {
        setMcpMetadata(null)
        if (showErrorNotice) {
          const message = error instanceof Error ? error.message : 'MCP 信息读取失败'
          setNotice(message)
        }
      } finally {
        setMcpMetadataLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void syncAiSettingsFromCloud(false, false)
  }, [syncAiSettingsFromCloud])

  useEffect(() => {
    void syncQuestionsFromCloud(false, false)
  }, [syncQuestionsFromCloud])

  useEffect(() => {
    void fetchMcpMetadata(false, false)
  }, [fetchMcpMetadata])

  const pathname = location.pathname
  const pathnameLower = pathname.toLowerCase()
  const editPathQuestionId = parseEditQuestionIdFromPath(pathname)
  const isEditing = editPathQuestionId !== null

  const aiConfigured =
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
        analysisMarkdown: resolveMarkdownForRender(buildQuestionAnalysisMarkdown(question)),
      })),
    [bankList, resolveMarkdownForRender],
  )

  const mcpToolSummary = useMemo(() => {
    if (!mcpMetadata || mcpMetadata.capabilities.tools.length === 0) {
      return '暂无可读取的 MCP 工具信息。'
    }

    return mcpMetadata.capabilities.tools
      .map((tool) => `${tool.name}：${tool.description || '未提供描述'}`)
      .join('\n')
  }, [mcpMetadata])

  const mcpResourceSummary = useMemo(() => {
    if (!mcpMetadata) {
      return '暂无可读取的 MCP 资源信息。'
    }

    const lines = [
      ...mcpMetadata.capabilities.staticResources.map(
        (resource) => `${resource.uri ?? resource.name}：${resource.description || '未提供描述'}`,
      ),
      ...mcpMetadata.capabilities.resourceTemplates.map(
        (resource) =>
          `${resource.uriTemplate ?? resource.name}：${resource.description || '未提供描述'}`,
      ),
    ]

    return lines.length > 0 ? lines.join('\n') : '暂无可读取的 MCP 资源信息。'
  }, [mcpMetadata])

  useEffect(() => {
    if (!questionsLoaded && INITIAL_LOCAL_QUESTION_SNAPSHOT === null) {
      return
    }
    if (questionsSyncedAt === null && INITIAL_LOCAL_QUESTION_SNAPSHOT === null && questions.length === 0) {
      return
    }

    saveQuestionSnapshotToLocalStorage(
      materializeQuestionSnapshot({
        questions,
        updatedAt: questionsSyncedAt,
      }),
    )
  }, [questions, questionsLoaded, questionsSyncedAt])

  useEffect(() => {
    if (!questionsLoaded || questionsSyncing) {
      return
    }
    if (questionsSyncedAt === null && INITIAL_LOCAL_QUESTION_SNAPSHOT === null && questions.length === 0) {
      return
    }

    const localSnapshot = materializeQuestionSnapshot({
      questions,
      updatedAt: questionsSyncedAt,
    })
    const serializedSnapshot = serializeQuestionSnapshot(localSnapshot)
    if (serializedSnapshot === questionCloudSnapshotRef.current) {
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        setQuestionsSaving(true)
        try {
          const headers: HeadersInit = {
            'Content-Type': 'application/json',
          }
          if (QUESTIONS_CLOUD_TOKEN) {
            headers.Authorization = `Bearer ${QUESTIONS_CLOUD_TOKEN}`
          }

          const response = await fetch(QUESTIONS_CLOUD_URL, {
            method: QUESTIONS_CLOUD_SAVE_METHOD,
            headers,
            body: JSON.stringify(localSnapshot),
          })
          const payload = await parseCloudResponseJson(response)
          if (!response.ok) {
            const detail = getPayloadMessage(payload)
            throw new Error(detail || `题库云端保存失败（HTTP ${response.status}）`)
          }

          const parsed = parseQuestionsCloudPayload(payload)
          const savedSnapshot = parsed?.snapshot
            ? materializeQuestionSnapshot(parsed.snapshot)
            : localSnapshot

          questionCloudSnapshotRef.current = serializeQuestionSnapshot(savedSnapshot)
          saveQuestionSnapshotToLocalStorage(savedSnapshot)

          if (!cancelled) {
            setQuestionsSyncedAt(savedSnapshot.updatedAt)
            if (!areQuestionSnapshotsEqual(savedSnapshot, localSnapshot)) {
              setQuestions(savedSnapshot.questions)
            }
          }
        } catch (error) {
          if (!cancelled) {
            const message = error instanceof Error ? error.message : '题库云端保存失败'
            setNotice(`${message}，题库已保存在本地缓存，可稍后手动同步。`)
          }
        } finally {
          if (!cancelled) {
            setQuestionsSaving(false)
          }
        }
      })()
    }, 700)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [questions, questionsLoaded, questionsSyncedAt, questionsSyncing])

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
    if (editPathQuestionId) {
      setCreateMode('manual')
    }
  }, [editPathQuestionId])

  useEffect(() => {
    draftTypeRef.current = draft.type
  }, [draft.type])

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
      if (type === 'choiceGroup') {
        return {
          ...prev,
          type,
          choiceGroupQuestions:
            prev.choiceGroupQuestions.length > 0 ? prev.choiceGroupQuestions : [createChoiceSubQuestion()],
        }
      }

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

  const updateChoiceGroupQuestion = (
    questionId: string,
    updater: (question: ChoiceSubQuestion) => ChoiceSubQuestion,
  ) => {
    setDraft((prev) => ({
      ...prev,
      choiceGroupQuestions: prev.choiceGroupQuestions.map((question) =>
        question.id === questionId ? updater(question) : question,
      ),
    }))
  }

  const addChoiceGroupQuestion = () => {
    setDraft((prev) => ({
      ...prev,
      choiceGroupQuestions: [...prev.choiceGroupQuestions, createChoiceSubQuestion()],
    }))
  }

  const removeChoiceGroupQuestion = (questionId: string) => {
    setDraft((prev) => {
      if (prev.choiceGroupQuestions.length <= 1) {
        return prev
      }
      return {
        ...prev,
        choiceGroupQuestions: prev.choiceGroupQuestions.filter((question) => question.id !== questionId),
      }
    })
  }

  const updateChoiceGroupStem = (questionId: string, value: string) => {
    const normalized = normalizeMarkdownForEdit(value)
    updateChoiceGroupQuestion(questionId, (question) => ({
      ...question,
      stem: normalized,
    }))
  }

  const updateChoiceGroupMode = (questionId: string, value: ChoiceMode) => {
    updateChoiceGroupQuestion(questionId, (question) => ({
      ...question,
      choiceMode: value,
      correctAnswers: sanitizeChoiceAnswers(value, question.correctAnswers, question.optionCount),
    }))
  }

  const updateChoiceGroupOptionStyle = (questionId: string, value: OptionStyle) => {
    updateChoiceGroupQuestion(questionId, (question) => ({
      ...question,
      optionStyle: value,
    }))
  }

  const updateChoiceGroupOptionCount = (questionId: string, rawCount: number) => {
    const count = Math.min(8, Math.max(2, rawCount))
    updateChoiceGroupQuestion(questionId, (question) => {
      const nextOptions =
        count > question.options.length
          ? [...question.options, ...Array.from({ length: count - question.options.length }, () => '')]
          : question.options

      return {
        ...question,
        optionCount: count,
        options: nextOptions,
        correctAnswers: sanitizeChoiceAnswers(question.choiceMode, question.correctAnswers, count),
      }
    })
  }

  const updateChoiceGroupOption = (questionId: string, optionIndex: number, value: string) => {
    updateChoiceGroupQuestion(questionId, (question) => {
      const nextOptions = [...question.options]
      nextOptions[optionIndex] = value
      return {
        ...question,
        options: nextOptions,
      }
    })
  }

  const toggleChoiceGroupAnswer = (questionId: string, answerIndex: number) => {
    updateChoiceGroupQuestion(questionId, (question) => {
      if (question.choiceMode === 'single') {
        return {
          ...question,
          correctAnswers: [answerIndex],
        }
      }

      const exists = question.correctAnswers.includes(answerIndex)
      const next = exists
        ? question.correctAnswers.filter((item) => item !== answerIndex)
        : [...question.correctAnswers, answerIndex]

      return {
        ...question,
        correctAnswers: sanitizeChoiceAnswers(question.choiceMode, next, question.optionCount),
      }
    })
  }

  const updateChoiceGroupAnalysis = (questionId: string, value: string) => {
    updateChoiceGroupQuestion(questionId, (question) => ({
      ...question,
      analysis: normalizeMarkdownForEdit(value),
    }))
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

  const clearQuickImportDraft = () => {
    setQuickImportHtml('')
    setQuickImportMarkdown('')
    setNotice('已清空快速导入内容。')
  }

  const applySingleImageImportResult = useCallback(
    (targetType: Exclude<QuestionType, 'choiceGroup'>, result: ParsedImageImportResponse) => {
      const normalizedStem = normalizeMarkdownForEdit(result.stemMarkdown)
      const normalizedOptions = result.options
        .map((option) => normalizeMarkdownForEdit(option))
        .filter((option) => option.trim().length > 0)
        .slice(0, 8)

      startTransition(() => {
        setDraft((prev) => {
          if (targetType === 'choice') {
            const nextOptions =
              normalizedOptions.length > 0
                ? ensureLength(
                    [
                      ...normalizedOptions,
                      ...Array.from({ length: Math.max(0, 8 - normalizedOptions.length) }, () => ''),
                    ],
                    8,
                  ).slice(0, 8)
                : prev.options

            const nextOptionCount =
              normalizedOptions.length >= 2
                ? Math.min(8, Math.max(2, normalizedOptions.length))
                : prev.optionCount

            return {
              ...prev,
              stem: normalizedStem || prev.stem,
              optionCount: nextOptionCount,
              options: nextOptions,
              choiceAnswers: sanitizeChoiceAnswers(prev.choiceMode, prev.choiceAnswers, nextOptionCount),
            }
          }

          if (targetType === 'blank') {
            const nextSlotCount = Math.max(1, detectInlineBlankCount(normalizedStem))
            return {
              ...prev,
              stem: normalizedStem || prev.stem,
              fillAnswers: ensureLength(prev.fillAnswers, nextSlotCount),
            }
          }

          const nextSlotCount = Math.max(1, normalizeSubjectiveStem(normalizedStem).blankCount)
          return {
            ...prev,
            stem: normalizedStem || prev.stem,
            subjectiveAnswers: ensureLength(prev.subjectiveAnswers, nextSlotCount),
          }
        })
      })
    },
    [normalizeMarkdownForEdit],
  )

  const submitSingleImageImport = async (file: File) => {
    if (!aiConfigured) {
      setNotice('请先在设置页同步云端 AI 配置。')
      return
    }

    if (draft.type === 'choiceGroup') {
      setNotice('快速图片导入仅支持单题，当前题型请改为选择题、填空题或主观题。')
      return
    }

    const targetType = draft.type

    const hasExistingContent =
      draft.stem.trim().length > 0 ||
      (targetType === 'choice' && draft.options.some((option) => option.trim().length > 0))

    if (hasExistingContent) {
      const confirmed = window.confirm('当前表单中已有题面内容。继续后会用识别结果覆盖题面，并尝试覆盖已识别出的选项，是否继续？')
      if (!confirmed) {
        return
      }
    }

    setSingleImageImporting(true)

    try {
      const dataUrl = await readFileAsDataUrl(file)
      const typeLabel =
        targetType === 'choice' ? '选择题' : targetType === 'blank' ? '填空题' : '主观题'
      const promptLines = [
        `当前目标题型：${typeLabel}`,
        '你是高中题面识别助手。请识别这张题目图片中的文字内容，并回填到当前单题表单。',
        '不要创建题目，不要输出任何解释，只返回 JSON。',
        '如果图片中存在配图、示意图、插图、图标或其他非文字内容，直接忽略，不要输出任何 Markdown 图片。',
        '如果文字附近夹杂图片，只提取能读到的文字即可。',
        '数学公式请尽量转成 LaTeX 或普通 Markdown 文本。',
      ]

      if (targetType === 'choice') {
        promptLines.push(
          '返回格式固定为 {"stem_markdown":"...","options":["..."]}。',
          'stem_markdown 只保留题干本体，不要把选项再塞进题干。',
          'options 只保留选项正文数组，不要包含 A. / B. / C. 之类前缀。',
          '如果没有稳定识别出选项，options 返回空数组即可。',
        )
      } else {
        promptLines.push(
          '返回格式固定为 {"stem_markdown":"..."}。',
          '只提取题面文字，不要生成答案、解析或补充说明。',
          '如果题面中有空位，请尽量保留下划线、括号等原始形式；无法稳定表示时可使用 ▲。',
        )
      }

      const response = await fetch(buildAIEndpoint(settings.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          temperature: 0.1,
          messages: [
            {
              role: 'system',
              content: '你是严谨的 OCR 题面提取助手。你只负责提取文字并输出 JSON。',
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: promptLines.join('\n'),
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: dataUrl,
                  },
                },
              ],
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

      const parsed = parseImageImportAiResponse(content)
      if (!parsed?.stemMarkdown.trim()) {
        throw new Error('未识别到可用题面文字，请换一张更清晰的图片后重试。')
      }

      if (draftTypeRef.current !== targetType) {
        setNotice('识别结果已返回，但当前题型已切换，未自动回填，请重新导入。')
        return
      }

      applySingleImageImportResult(targetType, parsed)

      if (targetType === 'choice') {
        setNotice(
          parsed.options.length >= 2
            ? '已识别图片内容并回填题面与选项，你可以继续补充答案、解析或图片。'
            : '已识别题面，但未稳定识别出完整选项，请手动补充后再创建。',
        )
      } else {
        setNotice('已识别图片内容并回填题面，你可以继续修改或补充图片。')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '快速图片导入失败'
      setNotice(message)
    } finally {
      setSingleImageImporting(false)
    }
  }

  const materializeQuickImportQuestion = useCallback(
    (item: QuickImportQuestionPayload, subject: SubjectKey, timestamp: string): Question | null => {
      if (item.type === 'choice') {
        const stem = item.stemMarkdown.trim()
        const options = item.options.map(stripLeadingOptionMarker).filter((option) => option.length > 0).slice(0, 8)
        if (!stem || options.length < 2) {
          return null
        }

        const optionStyle = normalizeOptionStyleValue(item.optionStyle)
        const parsedAnswers = parseChoiceAnswerIndices(item.correctAnswers, options.length, optionStyle)
        const choiceMode = normalizeChoiceModeValue(item.choiceMode, parsedAnswers.length)
        const disableAutoSpacing = hasNoPanguMarker(stem)
        const normalized = normalizeChoiceStem(stem)

        return {
          id: generateUuid(),
          subject,
          type: 'choice',
          stem: materializeMarkdownForStorage(stem, { disableAutoSpacing }),
          normalizedStem: materializeMarkdownForStorage(normalized.normalizedStem, { disableAutoSpacing }),
          createdAt: timestamp,
          updatedAt: timestamp,
          choiceMode,
          optionStyle,
          optionCount: options.length,
          options: options.map((option) => materializeMarkdownForStorage(option, { disableAutoSpacing })),
          correctAnswers: sanitizeChoiceAnswers(choiceMode, parsedAnswers, options.length),
          analysis: materializeMarkdownForStorage(item.analysisMarkdown.trim(), { disableAutoSpacing }),
        }
      }

      if (item.type === 'choiceGroup') {
        const groupStem = item.stemMarkdown.trim()
        const groupDisableAutoSpacing = hasNoPanguMarker(groupStem)
        const subquestions = item.subquestions
          .map((subquestion) => {
            const stem = subquestion.stemMarkdown.trim()
            const options = subquestion.options
              .map(stripLeadingOptionMarker)
              .filter((option) => option.length > 0)
              .slice(0, 8)

            if (!stem || options.length < 2) {
              return null
            }

            const optionStyle = normalizeOptionStyleValue(subquestion.optionStyle)
            const parsedAnswers = parseChoiceAnswerIndices(
              subquestion.correctAnswers,
              options.length,
              optionStyle,
            )
            const choiceMode = normalizeChoiceModeValue(subquestion.choiceMode, parsedAnswers.length)
            const disableAutoSpacing = groupDisableAutoSpacing || hasNoPanguMarker(stem)
            const normalized = normalizeChoiceStem(stem)

            return {
              id: generateUuid(),
              stem: materializeMarkdownForStorage(stem, { disableAutoSpacing }),
              normalizedStem: materializeMarkdownForStorage(normalized.normalizedStem, {
                disableAutoSpacing,
              }),
              choiceMode,
              optionStyle,
              optionCount: options.length,
              options: options.map((option) =>
                materializeMarkdownForStorage(option, {
                  disableAutoSpacing,
                }),
              ),
              correctAnswers: sanitizeChoiceAnswers(choiceMode, parsedAnswers, options.length),
              analysis: materializeMarkdownForStorage(subquestion.analysisMarkdown.trim(), {
                disableAutoSpacing,
              }),
            }
          })
          .filter((subquestion): subquestion is ChoiceSubQuestion => subquestion !== null)

        if (subquestions.length === 0) {
          return null
        }

        return {
          id: generateUuid(),
          subject,
          type: 'choiceGroup',
          stem: materializeMarkdownForStorage(groupStem, {
            disableAutoSpacing: groupDisableAutoSpacing,
          }),
          normalizedStem: materializeMarkdownForStorage(groupStem, {
            disableAutoSpacing: groupDisableAutoSpacing,
          }),
          createdAt: timestamp,
          updatedAt: timestamp,
          subquestions,
        }
      }

      if (item.type === 'blank') {
        const stem = item.stemMarkdown.trim()
        if (!stem) {
          return null
        }

        const disableAutoSpacing = hasNoPanguMarker(stem)
        const normalized = normalizeBlankStem(stem)
        const answers = ensureLength(item.answers.map((answer) => answer.trim()), normalized.blankCount)
          .slice(0, normalized.blankCount)

        return {
          id: generateUuid(),
          subject,
          type: 'blank',
          stem: materializeMarkdownForStorage(stem, { disableAutoSpacing }),
          normalizedStem: materializeMarkdownForStorage(normalized.normalizedStem, { disableAutoSpacing }),
          createdAt: timestamp,
          updatedAt: timestamp,
          blankCount: normalized.blankCount,
          answers: answers.map((answer) => materializeMarkdownForStorage(answer, { disableAutoSpacing })),
          analysis: materializeMarkdownForStorage(item.analysisMarkdown.trim(), { disableAutoSpacing }),
        }
      }

      const stem = item.stemMarkdown.trim()
      if (!stem) {
        return null
      }

      const disableAutoSpacing = hasNoPanguMarker(stem)
      const normalized = normalizeSubjectiveStem(stem)
      const answerCount = Math.max(1, normalized.blankCount)
      const answers = ensureLength(item.answers.map((answer) => answer.trim()), answerCount)
        .slice(0, answerCount)

      return {
        id: generateUuid(),
        subject,
        type: 'subjective',
        stem: materializeMarkdownForStorage(stem, { disableAutoSpacing }),
        normalizedStem: materializeMarkdownForStorage(normalized.normalizedStem, { disableAutoSpacing }),
        createdAt: timestamp,
        updatedAt: timestamp,
        areaCount: normalized.blankCount,
        answers: answers.map((answer) => materializeMarkdownForStorage(answer, { disableAutoSpacing })),
        analysis: materializeMarkdownForStorage(item.analysisMarkdown.trim(), { disableAutoSpacing }),
      }
    },
    [materializeMarkdownForStorage],
  )

  const submitQuickImport = async () => {
    if (!aiConfigured) {
      setNotice('请先在设置页同步云端 AI 配置。')
      return
    }

    const sourceMarkdown = quickImportMarkdown.trim()
    if (!sourceMarkdown) {
      setNotice('请先粘贴需要快速导入的内容。')
      return
    }

    const subjectLabel = SUBJECT_MAP[draft.subject].label
    const endpoint = buildAIEndpoint(settings.baseUrl)
    const imagePlaceholders = normalizeMarkdownImagePlaceholders(sourceMarkdown)

    const instructionLines = [
      `学科固定为：${subjectLabel}`,
      '你是高中题目录入助手。你的任务是把用户粘贴的一整段 Markdown 内容切分为 1 道或多道标准题目。',
      '必须识别题目边界，并为每道题选择最合适的 type：choice、choiceGroup、blank、subjective。',
      '若原文缺少答案或解析，需要结合题面自动补全，确保最终题目可以直接入库。',
      '若原文包含图片占位符，输出时必须原样保留对应的 Markdown 图片语法，不能改名、不能丢失、不能新增不存在的图片。',
      '表格尽量保留为 Markdown 表格；数学公式保持 Markdown/LaTeX。',
      '输出必须是 JSON（可放在 ```json 代码块中），根对象格式固定为：',
      '{"questions":[{"type":"choice","stem_markdown":"...","analysis_markdown":"...","choice_mode":"single","option_style":"latin","options":["..."],"correct_answers":["A"]}]}',
      '各字段要求如下：',
      '1. type 只能是 choice、choiceGroup、blank、subjective。',
      '2. stem_markdown 是题面 Markdown；choiceGroup 的 stem_markdown 是共享材料，可为空。',
      '3. analysis_markdown 是该题解析，使用 Markdown，但不要使用任何标题。',
      '4. choice/choiceGroup 的 options 必须是纯选项内容数组，不要再带 A. / B. 前缀。',
      '5. choice/choiceGroup 的 correct_answers 使用数组，内容为 A/B/C/①/②/1 等可识别选项标记。',
      '6. blank/subjective 使用 answers 数组。',
      '7. choiceGroup 使用 subquestions 数组，每个子题格式为 {"stem_markdown":"...","analysis_markdown":"...","choice_mode":"single","option_style":"latin","options":["..."],"correct_answers":["A"]}。',
      '8. 除 JSON 外不要输出任何额外说明。',
    ]

    if (imagePlaceholders.length > 0) {
      instructionLines.push(`当前可用图片占位符：${imagePlaceholders.join('、')}`)
    }

    const prompt = `${instructionLines.join('\n')}\n\n以下是待切题的原始 Markdown 内容：\n\n`
    const userMessageContent = buildQuickImportUserMessageContent(
      prompt,
      sourceMarkdown,
      imageMemoryRef.current,
    )

    setQuickImportSubmitting(true)

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          temperature: 0.1,
          messages: [
            {
              role: 'system',
              content:
                '你是严谨的高中题目录入助手。你必须稳定输出 JSON，并严格保留题面里的图片占位符与 Markdown 结构。',
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

      const parsedItems = parseQuickImportAiResponse(content)
      if (!parsedItems || parsedItems.length === 0) {
        throw new Error('AI 返回格式不完整，未识别到可导入的题目数组。')
      }

      const timestamp = new Date().toISOString()
      const createdQuestions = parsedItems
        .map((item) => materializeQuickImportQuestion(item, draft.subject, timestamp))
        .filter((item): item is Question => item !== null)

      if (createdQuestions.length === 0) {
        throw new Error('AI 已返回结果，但没有成功生成可入库的题目，请检查粘贴内容后重试。')
      }

      updateQuestions((prev) => [...createdQuestions, ...prev])
      toLocalStorage(LAST_CREATED_SUBJECT_KEY, draft.subject)
      setQuickImportHtml('')
      setQuickImportMarkdown('')

      const skippedCount = parsedItems.length - createdQuestions.length
      if (skippedCount > 0) {
        setNotice(`已批量创建 ${createdQuestions.length} 道题目，另有 ${skippedCount} 道未能入库。`)
      } else {
        setNotice(`已批量创建 ${createdQuestions.length} 道题目。`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '快速导入失败'
      setNotice(message)
    } finally {
      setQuickImportSubmitting(false)
    }
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

    updateQuestions((prev) => prev.filter((item) => item.id !== questionId))
    if (editingQuestionId === questionId || editPathQuestionId === questionId) {
      setEditingQuestionId(null)
      navigate('/create', { replace: true })
    }
    setNotice('题目已删除。')
  }

  const submitQuestion = () => {
    const stem = draft.stem.trim()
    if (!stem) {
      setNotice(draft.type === 'choiceGroup' ? '请先输入共享材料。' : '请先输入题面。')
      return
    }

    const now = new Date().toISOString()
    const originalQuestion = editPathQuestionId
      ? questions.find((item) => item.id === editPathQuestionId)
      : null
    const questionId = originalQuestion?.id ?? generateUuid()
    const createdAt = originalQuestion?.createdAt ?? now

    if (draft.type === 'choice') {
      const disableAutoSpacing = hasNoPanguMarker(stem)
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
        stem: materializeMarkdownForStorage(stem, { disableAutoSpacing }),
        normalizedStem: materializeMarkdownForStorage(normalized.normalizedStem, { disableAutoSpacing }),
        createdAt,
        updatedAt: now,
        choiceMode: draft.choiceMode,
        optionStyle: draft.optionStyle,
        optionCount: draft.optionCount,
        options: options.map((item) => materializeMarkdownForStorage(item, { disableAutoSpacing })),
        correctAnswers: answers,
        analysis: materializeMarkdownForStorage(draft.choiceAnalysis.trim(), { disableAutoSpacing }),
      }

      updateQuestions((prev) =>
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

    if (draft.type === 'choiceGroup') {
      const groupDisableAutoSpacing = hasNoPanguMarker(stem)
      const subquestions = draft.choiceGroupQuestions.map((subquestion, index) => {
        const normalized = normalizeChoiceStem(subquestion.stem.trim())
        const options = subquestion.options.slice(0, subquestion.optionCount).map((item) => item.trim())
        const answers = sanitizeChoiceAnswers(
          subquestion.choiceMode,
          subquestion.correctAnswers,
          subquestion.optionCount,
        )

        return {
          index,
          subquestion,
          normalized,
          options,
          answers,
        }
      })

      if (subquestions.length === 0) {
        setNotice('请至少保留 1 道子题。')
        return
      }

      for (const item of subquestions) {
        if (!item.subquestion.stem.trim()) {
          setNotice(`请先补全第 ${item.index + 1} 道子题的题面。`)
          return
        }

        if (item.options.some((option) => option.length === 0)) {
          setNotice(`第 ${item.index + 1} 道子题仍有空白选项，请补全后再保存。`)
          return
        }

        if (!validateChoiceAnswers(item.subquestion.choiceMode, item.answers)) {
          if (item.subquestion.choiceMode === 'single') {
            setNotice(`第 ${item.index + 1} 道子题必须且只能选择 1 个正确选项。`)
            return
          }
          if (item.subquestion.choiceMode === 'double') {
            setNotice(`第 ${item.index + 1} 道子题必须选择 2 个正确选项。`)
            return
          }
          setNotice(`第 ${item.index + 1} 道子题至少要有 1 个正确选项。`)
          return
        }
      }

      const nextQuestion: Question = {
        id: questionId,
        subject: draft.subject,
        type: 'choiceGroup',
        stem: materializeMarkdownForStorage(stem, {
          disableAutoSpacing: groupDisableAutoSpacing,
        }),
        normalizedStem: materializeMarkdownForStorage(stem, {
          disableAutoSpacing: groupDisableAutoSpacing,
        }),
        createdAt,
        updatedAt: now,
        subquestions: subquestions.map(({ subquestion, normalized, options, answers }) => {
          const disableAutoSpacing = groupDisableAutoSpacing || hasNoPanguMarker(subquestion.stem)
          return {
            id: subquestion.id,
            stem: materializeMarkdownForStorage(subquestion.stem.trim(), {
              disableAutoSpacing,
            }),
            normalizedStem: materializeMarkdownForStorage(normalized.normalizedStem, {
              disableAutoSpacing,
            }),
            choiceMode: subquestion.choiceMode,
            optionStyle: subquestion.optionStyle,
            optionCount: subquestion.optionCount,
            options: options.map((option) =>
              materializeMarkdownForStorage(option, {
                disableAutoSpacing,
              }),
            ),
            correctAnswers: answers,
            analysis: materializeMarkdownForStorage(subquestion.analysis.trim(), {
              disableAutoSpacing,
            }),
          }
        }),
      }

      updateQuestions((prev) =>
        originalQuestion
          ? prev.map((item) => (item.id === questionId ? nextQuestion : item))
          : [nextQuestion, ...prev],
      )
      if (!originalQuestion) {
        toLocalStorage(LAST_CREATED_SUBJECT_KEY, draft.subject)
      }

      const appendedCount = subquestions.filter((item) => item.normalized.appended).length
      const multipleCount = subquestions.filter((item) => item.normalized.hadMultiple).length

      if (originalQuestion) {
        if (appendedCount > 0 || multipleCount > 0) {
          const parts: string[] = []
          if (appendedCount > 0) {
            parts.push(`${appendedCount} 道子题未识别到空位，已自动补空位`)
          }
          if (multipleCount > 0) {
            parts.push(`${multipleCount} 道子题存在多个空位，已按最后一个空位处理`)
          }
          setNotice(`多空选择题已更新。${parts.join('；')}。`)
        } else {
          setNotice('多空选择题已更新。')
        }
      } else if (appendedCount > 0 || multipleCount > 0) {
        const parts: string[] = []
        if (appendedCount > 0) {
          parts.push(`${appendedCount} 道子题未识别到空位，已自动补空位`)
        }
        if (multipleCount > 0) {
          parts.push(`${multipleCount} 道子题存在多个空位，已按最后一个空位处理`)
        }
        setNotice(`创建成功。${parts.join('；')}。`)
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
      const disableAutoSpacing = hasNoPanguMarker(stem)
      const normalized = normalizeBlankStem(stem)
      const answers = ensureLength(draft.fillAnswers, normalized.blankCount)
        .slice(0, normalized.blankCount)
        .map((item) => item.trim())

      const nextQuestion: Question = {
        id: questionId,
        subject: draft.subject,
        type: 'blank',
        stem: materializeMarkdownForStorage(stem, { disableAutoSpacing }),
        normalizedStem: materializeMarkdownForStorage(normalized.normalizedStem, { disableAutoSpacing }),
        createdAt,
        updatedAt: now,
        blankCount: normalized.blankCount,
        answers: answers.map((item) => materializeMarkdownForStorage(item, { disableAutoSpacing })),
        analysis: materializeMarkdownForStorage(draft.fillAnalysis.trim(), { disableAutoSpacing }),
      }

      updateQuestions((prev) =>
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

    const disableAutoSpacing = hasNoPanguMarker(stem)
    const normalized = normalizeSubjectiveStem(stem)
    const answerCount = Math.max(1, normalized.blankCount)
    const answers = ensureLength(draft.subjectiveAnswers, answerCount)
      .slice(0, answerCount)
      .map((item) => item.trim())

    const nextQuestion: Question = {
      id: questionId,
      subject: draft.subject,
      type: 'subjective',
      stem: materializeMarkdownForStorage(stem, { disableAutoSpacing }),
      normalizedStem: materializeMarkdownForStorage(normalized.normalizedStem, { disableAutoSpacing }),
      createdAt,
      updatedAt: now,
      areaCount: normalized.blankCount,
      answers: answers.map((item) => materializeMarkdownForStorage(item, { disableAutoSpacing })),
      analysis: materializeMarkdownForStorage(draft.subjectiveAnalysis.trim(), { disableAutoSpacing }),
    }

    updateQuestions((prev) =>
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
      setNotice(target === 'choiceGroup' ? '请先输入共享材料。' : '请先输入题面。')
      return
    }

    let answerProvided: boolean
    let shouldGenerateAnswers = false
    let givenAnswerText: string
    let answerCount: number

    if (target === 'choice') {
      const selected = sanitizeChoiceAnswers(draft.choiceMode, draft.choiceAnswers, draft.optionCount)
      answerProvided = validateChoiceAnswers(draft.choiceMode, selected)
      givenAnswerText = selected
        .map((index) => getOptionMarker(index, draft.optionStyle))
        .join('、')
      answerCount = draft.choiceMode === 'double' ? 2 : 1
    } else if (target === 'choiceGroup') {
      if (draft.choiceGroupQuestions.length === 0) {
        setNotice('请至少保留 1 道子题。')
        return
      }

      const invalidSubquestion = draft.choiceGroupQuestions.find((subquestion, index) => {
        if (!subquestion.stem.trim()) {
          setNotice(`请先补全第 ${index + 1} 道子题的题面。`)
          return true
        }
        const options = subquestion.options.slice(0, subquestion.optionCount).map((item) => item.trim())
        if (options.some((item) => item.length === 0)) {
          setNotice(`请先补全第 ${index + 1} 道子题的选项，再生成解析。`)
          return true
        }
        return false
      })
      if (invalidSubquestion) {
        return
      }

      const answerSummaries = draft.choiceGroupQuestions.map((subquestion, index) => {
        const selected = sanitizeChoiceAnswers(
          subquestion.choiceMode,
          subquestion.correctAnswers,
          subquestion.optionCount,
        )
        const valid = validateChoiceAnswers(subquestion.choiceMode, selected)
        return {
          index,
          selected,
          valid,
          markerText: selected.map((item) => getOptionMarker(item, subquestion.optionStyle)).join('、'),
        }
      })

      answerProvided = answerSummaries.every((item) => item.valid)
      givenAnswerText = answerSummaries
        .map((item) =>
          `第${item.index + 1}题：${item.valid ? item.markerText || '（空）' : '未填写完整'}`,
        )
        .join('\n')
      answerCount = draft.choiceGroupQuestions.length
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

    let questionBody = `学科：${subjectLabel}\n题型：${QUESTION_TYPE_LABEL[target]}\n\n${
      target === 'choiceGroup' ? '共享材料' : '题面'
    }：\n${stem}\n`

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

    if (target === 'choiceGroup') {
      const subquestionText = draft.choiceGroupQuestions
        .map((subquestion, index) => {
          const options = subquestion.options.slice(0, subquestion.optionCount).map((item) => item.trim())
          const optionsText = options
            .map((option, optionIndex) => `${getOptionMarker(optionIndex, subquestion.optionStyle)} ${option}`)
            .join('\n')
          return [
            `第${index + 1}题`,
            `子类型：${CHOICE_MODE_LABEL[subquestion.choiceMode]}`,
            `选项风格：${subquestion.optionStyle === 'circle' ? '①②③' : 'ABCD'}`,
            `题面：\n${subquestion.stem.trim()}`,
            `选项：\n${optionsText}`,
          ].join('\n')
        })
        .join('\n\n')
      questionBody += `\n子题列表：\n${subquestionText}\n`
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
    ]

    if (target !== 'choiceGroup') {
      policyLines.push(`generated_answers 若需要提供答案，长度应为 ${answerCount}（选择题可用选项标识符）。`)
    }

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

    if (target === 'choiceGroup') {
      policyLines.push('这是共享材料下的多道独立选择题，必须逐题分析，不可混答。')
      policyLines.push(
        '必须优先返回 JSON（可放在 ```json 代码块中），格式为 {"subquestions":[{"analysis_markdown":"...","generated_answers":["A"],"answer_reasonable":true/false/null,"reasonability_comment":"..."}, ...]}。',
      )
      policyLines.push('subquestions 数组长度必须与子题数量完全一致，顺序必须和题目顺序一致。')
      policyLines.push('每个 analysis_markdown 仅对应各自子题，不要合并成总解析。')
      policyLines.push('每个 generated_answers 只填写对应子题的答案；单选/双选/不定项都可用选项标识符。')
      if (isHumanities) {
        policyLines.push('文科多空选择题需结合共享材料与所学知识逐题说明依据，并尽量指出对应来源。')
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

      if (target === 'choiceGroup') {
        const parsedGroup = parseChoiceGroupAiResponse(content, draft.choiceGroupQuestions.length)
        if (!parsedGroup) {
          throw new Error('AI 返回格式不完整，未识别到多空选择题的逐题 JSON 结果。')
        }

        const suggestedPerQuestion = parsedGroup.map((item, index) => {
          const subquestion = draft.choiceGroupQuestions[index]
          const indices = parseChoiceAnswerIndices(
            item.generatedAnswers,
            subquestion.optionCount,
            subquestion.optionStyle,
          )
          const generated = sanitizeChoiceAnswers(subquestion.choiceMode, indices, subquestion.optionCount)
          return {
            generated,
            analysis: item.analysisMarkdown,
            answerReasonable: item.answerReasonable,
            reasonabilityComment: item.reasonabilityComment,
            valid: validateChoiceAnswers(subquestion.choiceMode, generated),
          }
        })

        if (shouldGenerateAnswers) {
          const allValid = suggestedPerQuestion.every((item) => item.valid)
          setDraft((prev) => ({
            ...prev,
            choiceGroupQuestions: prev.choiceGroupQuestions.map((subquestion, index) => ({
              ...subquestion,
              analysis: suggestedPerQuestion[index].analysis || subquestion.analysis,
              correctAnswers: suggestedPerQuestion[index].valid
                ? suggestedPerQuestion[index].generated
                : subquestion.correctAnswers,
            })),
          }))
          setNotice(
            allValid
              ? 'AI 已生成多空选择题答案与解析。'
              : 'AI 已生成多空选择题解析，但部分答案格式不完整，请手动确认。',
          )
          return
        }

        if (shouldCheckReasonability) {
          const replaceableIndices = suggestedPerQuestion
            .map((item, index) =>
              item.answerReasonable === false && item.valid ? index : -1,
            )
            .filter((index) => index >= 0)

          if (replaceableIndices.length > 0) {
            const reasons = replaceableIndices
              .map((index) => {
                const reasonText =
                  suggestedPerQuestion[index].reasonabilityComment || 'AI 认为当前答案可能不合理。'
                return `第${index + 1}题：${reasonText}`
              })
              .join('\n')

            const confirmed = window.confirm(`${reasons}\n\n是否使用 AI 建议答案覆盖这些子题的当前答案？`)

            setDraft((prev) => ({
              ...prev,
              choiceGroupQuestions: prev.choiceGroupQuestions.map((subquestion, index) => ({
                ...subquestion,
                analysis: suggestedPerQuestion[index].analysis || subquestion.analysis,
                correctAnswers:
                  confirmed && replaceableIndices.includes(index)
                    ? suggestedPerQuestion[index].generated
                    : subquestion.correctAnswers,
              })),
            }))

            setNotice(confirmed ? 'AI 建议答案已覆盖，解析已更新。' : '已保留原答案，仅更新解析。')
            return
          }
        }

        setDraft((prev) => ({
          ...prev,
          choiceGroupQuestions: prev.choiceGroupQuestions.map((subquestion, index) => ({
            ...subquestion,
            analysis: suggestedPerQuestion[index].analysis || subquestion.analysis,
          })),
        }))
        setNotice('多空选择题 AI 解析已生成。')
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

  const openPdfExportDialog = (target: PdfExportTarget) => {
    if (bankList.length === 0) {
      setNotice('当前筛选下暂无题目可导出。')
      return
    }

    setPdfExportDialogTarget(target)
    setPdfExportConfig(loadPdfExportSpacingConfig())
  }

  const persistPdfExportConfig = (config: PdfExportSpacingConfig, message: string) => {
    const sanitized = sanitizePdfExportSpacingConfig(config)
    savePdfExportSpacingConfig(sanitized)
    setPdfExportConfig(sanitized)
    setNotice(message)
  }

  const resetPdfExportConfig = () => {
    persistPdfExportConfig(DEFAULT_PDF_EXPORT_SPACING_CONFIG, '导出配置已重置为默认值。')
  }

  const savePdfExportConfigLocally = () => {
    persistPdfExportConfig(pdfExportConfig, '导出配置已保存到浏览器本地。')
  }

  const exportPdf = async (target: PdfExportTarget, config: PdfExportSpacingConfig) => {
    const includeAnalysis = target === 'analysis'

    setPdfExporting(true)
    setPdfExportingTarget(target)
    setNotice('正在生成 PDF，请稍候...')
    try {
      const { exportQuestionsAsPdf } = await import('./lib/pdfExport')
      const result = await exportQuestionsAsPdf(bankList, {
        includeAnalysis,
        spacingConfig: sanitizePdfExportSpacingConfig(config),
      })
      setNotice(result.message)
      setPdfExportDialogTarget(null)
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
  const stemEditorLabel = draft.type === 'choiceGroup' ? '共享材料' : '题面'
  const stemEditorPlaceholder =
    draft.type === 'choiceGroup'
      ? `可输入 Markdown 与 LaTeX，作为多道子题共享的材料。\n子题题面请在下方分别填写；每道子题仍可用括号、下划线或两侧有空白字符的 ▲ 表示空位。`
      : `可输入 Markdown 与 LaTeX。\n选择题/填空题可用括号、下划线，或两侧有空白字符的 ▲ 表示空位；材料题可用连续换行或独立 ▲ 表示大面积留空。`

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
            <>
              <section className="pane">
                <header className="pane-head">
                  <h2>AI 设置</h2>
                  <p>启动时会比较云端与本地缓存版本，优先使用时间戳较新的配置，并自动回写较旧的一侧。</p>
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
                      value={settings.baseUrl}
                      placeholder="例如 https://api.openai.com/v1"
                      onChange={(event) =>
                        setSettings((prev) => ({
                          ...prev,
                          baseUrl: event.target.value,
                        }))
                      }
                    />
                  </label>

                  <label>
                    API Key
                    <input
                      type="password"
                      value={settings.apiKey}
                      placeholder="sk-..."
                      onChange={(event) =>
                        setSettings((prev) => ({
                          ...prev,
                          apiKey: event.target.value,
                        }))
                      }
                    />
                  </label>

                  <label>
                    模型名称
                    <input
                      type="text"
                      value={settings.model}
                      placeholder="例如 gpt-4o-mini 或其它兼容模型"
                      onChange={(event) =>
                        setSettings((prev) => ({
                          ...prev,
                          model: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>

                <div className="settings-actions">
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={() => void saveAiSettingsToCloud()}
                    disabled={aiSettingsSyncing || aiSettingsSaving}
                  >
                    {aiSettingsSaving ? '保存中...' : '保存到云端'}
                  </button>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => void syncAiSettingsFromCloud(true)}
                    disabled={aiSettingsSyncing || aiSettingsSaving}
                  >
                    {aiSettingsSyncing ? '同步中...' : '从云端重新拉取'}
                  </button>
                  <p className={aiConfigured ? 'status-ok' : 'status-warn'}>
                    当前状态：
                    {aiSettingsSyncing
                      ? '同步中'
                      : aiSettingsSaving
                        ? '保存中'
                        : !aiSettingsLoaded
                          ? '初始化中'
                          : aiConfigured
                            ? '可用'
                            : '不可用'}
                  </p>
                  <p className="hint">
                    最近同步：{aiSettingsSyncedAt ? formatDateTime(aiSettingsSyncedAt) : '尚未成功同步'}
                  </p>
                </div>
              </section>

              <section className="pane">
                <header className="pane-head">
                  <h2>题库云端同步</h2>
                  <p>网页端和 AI Agent 共用这一份题库快照，启动时也会自动完成新旧版本对齐。</p>
                </header>

                <div className="settings-grid">
                  <label>
                    题库云端地址
                    <input type="text" value={QUESTIONS_CLOUD_URL} readOnly />
                  </label>

                  <label>
                    当前题目数量
                    <input type="text" value={String(questions.length)} readOnly />
                  </label>
                </div>

                <div className="settings-actions">
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => void syncQuestionsFromCloud(true)}
                    disabled={questionsSyncing || questionsSaving}
                  >
                    {questionsSyncing ? '同步中...' : '从云端重新拉取'}
                  </button>
                  <p className={questionsLoaded ? 'status-ok' : 'status-warn'}>
                    当前状态：
                    {questionsSyncing
                      ? '同步中'
                      : questionsSaving
                        ? '回写云端中'
                        : !questionsLoaded
                          ? '初始化中'
                          : '已就绪'}
                  </p>
                  <p className="hint">
                    最近同步：{questionsSyncedAt ? formatDateTime(questionsSyncedAt) : '尚未成功同步'}
                  </p>
                </div>
              </section>

              <section className="pane">
                <header className="pane-head">
                  <h2>MCP 接入</h2>
                  <p>Agent 可通过标准 MCP JSON-RPC 直连题库；后续新增能力也会继续挂在同一套工具注册层里。</p>
                </header>

                <div className="settings-grid">
                  <label>
                    MCP 服务地址
                    <input type="text" value={mcpMetadata?.endpoint ?? MCP_SERVER_URL} readOnly />
                  </label>

                  <label>
                    鉴权方式
                    <input
                      type="text"
                      value={
                        mcpMetadata
                          ? mcpMetadata.authRequired
                            ? 'Bearer Token'
                            : '无需鉴权'
                          : '读取中'
                      }
                      readOnly
                    />
                  </label>

                  <label className="settings-textarea-field">
                    已暴露工具
                    <textarea value={mcpToolSummary} readOnly rows={6} />
                  </label>

                  <label className="settings-textarea-field">
                    资源入口
                    <textarea value={mcpResourceSummary} readOnly rows={6} />
                  </label>
                </div>

                <div className="settings-actions">
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => void fetchMcpMetadata(true, true)}
                    disabled={mcpMetadataLoading}
                  >
                    {mcpMetadataLoading ? '读取中...' : '刷新 MCP 信息'}
                  </button>
                  <p className={mcpMetadata ? 'status-ok' : 'status-warn'}>
                    当前状态：
                    {mcpMetadataLoading ? '读取中' : mcpMetadata ? '可接入' : '未读取到服务信息'}
                  </p>
                  <p className="hint">
                    默认支持 `initialize`、`tools/list`、`tools/call`、`resources/list`、`resources/read`。
                  </p>
                </div>
              </section>
            </>
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
                {!isEditing ? (
                  <div className="type-picker create-mode-picker">
                    <p>创建方式</p>
                    <div>
                      <button
                        type="button"
                        className={createMode === 'manual' ? 'active' : ''}
                        onClick={() => setCreateMode('manual')}
                      >
                        普通创建
                      </button>
                      <button
                        type="button"
                        className={createMode === 'quickImport' ? 'active' : ''}
                        onClick={() => setCreateMode('quickImport')}
                      >
                        快速导入
                      </button>
                    </div>
                  </div>
                ) : null}

                {createMode === 'manual' || isEditing ? (
                  <>
                <section className="section-block single-image-import-block">
                  <div className="section-headline">
                    <div>
                      <h3>快速图片导入</h3>
                      <p className="hint">
                        上传单张题目图片，AI 会先识别文字并回填当前表单；不会立即创建题目，后续仍可手动修改。
                      </p>
                    </div>
                    <div className="section-actions">
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={singleImageImporting || draft.type === 'choiceGroup'}
                        onClick={() => singleImageImportInputRef.current?.click()}
                      >
                        {singleImageImporting ? '识别中...' : '快速图片导入'}
                      </button>
                    </div>
                  </div>

                  {draft.type === 'choiceGroup' ? (
                    <p className="hint">当前为多空选择题。快速图片导入仅支持单题，请先切换到单题类型。</p>
                  ) : (
                    <p className="hint">如果图片中夹杂配图或小图，系统只提取文字，图片部分会忽略，后续可手动补回。</p>
                  )}

                  <input
                    ref={singleImageImportInputRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (file) {
                        void submitSingleImageImport(file)
                      }
                      event.currentTarget.value = ''
                    }}
                  />
                </section>

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
                  label={stemEditorLabel}
                  value={draft.stem}
                  onChange={updateStem}
                  allowImages
                  onResolveImageDataUrl={rememberImageInMemory}
                  resolveMarkdownForPreview={resolveMarkdownForPreview}
                  minRows={8}
                  placeholder={stemEditorPlaceholder}
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

                {draft.type === 'choiceGroup' ? (
                  <section className="section-block">
                    <div className="section-headline">
                      <div>
                        <h3>多空选择题参数</h3>
                        <p className="hint">
                          共享材料只写一次；下方每道子题都有自己的题面、选项、答案与解析，互不共享。
                        </p>
                      </div>
                      <div className="section-actions">
                        <button
                          type="button"
                          className="ghost-btn"
                          disabled={aiLoadingTarget !== null}
                          onClick={() => {
                            void generateAnalysisWithAI('choiceGroup')
                          }}
                        >
                          {aiLoadingTarget === 'choiceGroup' ? '生成中...' : 'AI 生成答案与解析'}
                        </button>
                        <button type="button" className="ghost-btn" onClick={addChoiceGroupQuestion}>
                          新增一题
                        </button>
                      </div>
                    </div>

                    <div className="group-question-list">
                      {draft.choiceGroupQuestions.map((subquestion, groupIndex) => {
                        const detectedBlankCount = detectInlineBlankCount(subquestion.stem)
                        const visibleOptions = subquestion.options.slice(0, subquestion.optionCount)
                        const hiddenOptionCount = Math.max(
                          subquestion.options.length - subquestion.optionCount,
                          0,
                        )

                        return (
                          <section key={subquestion.id} className="group-question-card">
                            <header className="group-question-head">
                              <div>
                                <h4>第 {groupIndex + 1} 题</h4>
                                <p className="hint">可穿插单选、双选、不定项，以及不同选项风格。</p>
                              </div>
                              <button
                                type="button"
                                className="ghost-btn danger"
                                onClick={() => removeChoiceGroupQuestion(subquestion.id)}
                                disabled={draft.choiceGroupQuestions.length <= 1}
                              >
                                删除本题
                              </button>
                            </header>

                            <MarkdownEditor
                              label="子题题面"
                              value={subquestion.stem}
                              onChange={(value) => updateChoiceGroupStem(subquestion.id, value)}
                              allowImages
                              onResolveImageDataUrl={rememberImageInMemory}
                              resolveMarkdownForPreview={resolveMarkdownForPreview}
                              minRows={6}
                              placeholder={`请输入第 ${groupIndex + 1} 题题面。\n可用括号、下划线，或两侧有空白字符的 ▲ 表示空位。`}
                            />

                            {detectedBlankCount === 0 ? (
                              <p className="hint">未识别到空位时，系统会在该子题题面末尾自动追加一个空位。</p>
                            ) : null}
                            {detectedBlankCount > 1 ? (
                              <p className="warn-text">
                                当前子题识别到多个空位，保存时会按最后一个空位处理。
                              </p>
                            ) : null}

                            <div className="inline-grid">
                              <label>
                                选择题子类型
                                <select
                                  value={subquestion.choiceMode}
                                  onChange={(event) =>
                                    updateChoiceGroupMode(
                                      subquestion.id,
                                      event.target.value as ChoiceMode,
                                    )
                                  }
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
                                  value={subquestion.optionStyle}
                                  onChange={(event) =>
                                    updateChoiceGroupOptionStyle(
                                      subquestion.id,
                                      event.target.value as OptionStyle,
                                    )
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
                                  value={subquestion.optionCount}
                                  onChange={(event) =>
                                    updateChoiceGroupOptionCount(
                                      subquestion.id,
                                      Number(event.target.value),
                                    )
                                  }
                                />
                              </label>
                            </div>

                            {hiddenOptionCount > 0 ? (
                              <p className="hint">
                                当前隐藏了 {hiddenOptionCount} 个选项草稿，若再调大数量可恢复内容。
                              </p>
                            ) : null}

                            <div className="option-list">
                              {visibleOptions.map((option, optionIndex) => (
                                <div key={optionIndex} className="option-item">
                                  <label>
                                    选项 {getOptionMarker(optionIndex, subquestion.optionStyle)}
                                    <textarea
                                      rows={2}
                                      value={option}
                                      onChange={(event) =>
                                        updateChoiceGroupOption(
                                          subquestion.id,
                                          optionIndex,
                                          event.target.value,
                                        )
                                      }
                                      placeholder={`请输入选项 ${getOptionMarker(optionIndex, subquestion.optionStyle)}（支持 Markdown，允许换行）`}
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
                                {visibleOptions.map((_option, optionIndex) => (
                                  <label key={optionIndex}>
                                    <input
                                      type={subquestion.choiceMode === 'single' ? 'radio' : 'checkbox'}
                                      checked={subquestion.correctAnswers.includes(optionIndex)}
                                      onChange={() =>
                                        toggleChoiceGroupAnswer(subquestion.id, optionIndex)
                                      }
                                    />
                                    {getOptionMarker(optionIndex, subquestion.optionStyle)}
                                  </label>
                                ))}
                              </div>
                            </div>

                            <MarkdownEditor
                              label="解析"
                              value={subquestion.analysis}
                              onChange={(value) => updateChoiceGroupAnalysis(subquestion.id, value)}
                              allowImages
                              onResolveImageDataUrl={rememberImageInMemory}
                              resolveMarkdownForPreview={resolveMarkdownForPreview}
                              minRows={5}
                              placeholder={`可选。输入第 ${groupIndex + 1} 题解析（Markdown/LaTeX）`}
                            />
                          </section>
                        )
                      })}
                    </div>
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
                  </>
                ) : (
                  <>
                    <section className="section-block quick-import-block">
                      <div className="section-headline">
                        <div>
                          <h3>快速导入题目</h3>
                          <p className="hint">
                            直接粘贴 Word、网页、表格、图片或多道题混合内容；系统会先转成 Markdown，再交给 AI 批量切题。
                          </p>
                        </div>
                      </div>

                      <RichPasteEditor
                        label="导入内容"
                        htmlValue={quickImportHtml}
                        markdownValue={quickImportMarkdown}
                        onHtmlChange={setQuickImportHtml}
                        onMarkdownChange={setQuickImportMarkdown}
                        onResolveImageDataUrl={rememberImageInMemory}
                        resolveMarkdownForPreview={resolveMarkdownForPreview}
                        minHeight={280}
                        placeholder="把任意格式的题目内容直接粘贴到这里。支持一次性粘贴多道题、表格和图片。"
                      />

                      <p className="hint">
                        内部会自动生成 Markdown 并保留图片占位符；点击创建后，AI 会完成切题、识别题型并批量入库。
                      </p>
                    </section>

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
                      <button
                        type="button"
                        className="primary-btn"
                        disabled={quickImportSubmitting}
                        onClick={() => {
                          void submitQuickImport()
                        }}
                      >
                        {quickImportSubmitting ? '创建中...' : '批量创建题目'}
                      </button>
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={quickImportSubmitting}
                        onClick={clearQuickImportDraft}
                      >
                        清空导入内容
                      </button>
                    </div>
                  </>
                )}
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
                  onClick={() => openPdfExportDialog('plain')}
                  disabled={pdfExporting}
                >
                  {pdfExporting && pdfExportingTarget === 'plain' ? '导出中...' : '导出题面 PDF'}
                </button>

                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => openPdfExportDialog('analysis')}
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

          <ExportConfigModal
            open={pdfExportDialogTarget !== null}
            targetLabel={
              pdfExportDialogTarget ? PDF_EXPORT_TARGET_LABEL[pdfExportDialogTarget] : '题面 PDF'
            }
            exporting={pdfExporting}
            config={pdfExportConfig}
            onChange={(key, value) =>
              setPdfExportConfig((prev) => sanitizePdfExportSpacingConfig({ ...prev, [key]: value }))
            }
            onClose={() => setPdfExportDialogTarget(null)}
            onReset={resetPdfExportConfig}
            onSave={savePdfExportConfigLocally}
            onConfirm={() => {
              if (!pdfExportDialogTarget) {
                return
              }
              const config = sanitizePdfExportSpacingConfig(pdfExportConfig)
              savePdfExportSpacingConfig(config)
              setPdfExportConfig(config)
              void exportPdf(pdfExportDialogTarget, config)
            }}
          />

          {notice ? <div className="toast">{notice}</div> : null}
        </main>
      </div>
    </div>
  )
}

export default App
