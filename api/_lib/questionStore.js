import { normalizeTimestamp } from './http.js'
import { loadJsonRecord, saveJsonRecord } from './kv.js'

const QUESTIONS_KV_KEY = process.env.QUESTIONS_KV_KEY || 'correct:questions:v1'

const SUBJECT_KEYS = new Set([
  'chinese',
  'math',
  'english',
  'politics',
  'history',
  'geography',
  'physics',
  'chemistry',
  'biology',
  'other',
])

const QUESTION_TYPES = new Set(['choice', 'choiceGroup', 'blank', 'subjective'])
const CHOICE_MODES = new Set(['single', 'double', 'multiple'])
const OPTION_STYLES = new Set(['latin', 'circle'])

function generateId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  return `question_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }

  return Math.min(max, Math.max(min, Math.round(numeric)))
}

function normalizeString(value) {
  return typeof value === 'string' ? value : String(value ?? '')
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => normalizeString(item)) : []
}

function normalizeSubject(value) {
  return typeof value === 'string' && SUBJECT_KEYS.has(value) ? value : 'other'
}

function normalizeQuestionType(value) {
  return typeof value === 'string' && QUESTION_TYPES.has(value) ? value : 'subjective'
}

function normalizeChoiceMode(value) {
  return typeof value === 'string' && CHOICE_MODES.has(value) ? value : 'single'
}

function normalizeOptionStyle(value) {
  return typeof value === 'string' && OPTION_STYLES.has(value) ? value : 'latin'
}

function sanitizeChoiceAnswers(value, optionCount) {
  if (!Array.isArray(value)) {
    return []
  }

  return [...new Set(value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 0 && item < optionCount))].sort(
    (left, right) => left - right,
  )
}

function ensureLength(list, length, fillValue = '') {
  const next = list.slice(0, length)
  while (next.length < length) {
    next.push(fillValue)
  }
  return next
}

function normalizeBaseQuestion(item) {
  const now = new Date().toISOString()
  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : generateId(),
    subject: normalizeSubject(item.subject),
    stem: normalizeString(item.stem),
    normalizedStem: normalizeString(item.normalizedStem ?? item.stem),
    createdAt: normalizeTimestamp(item.createdAt) || now,
    updatedAt: normalizeTimestamp(item.updatedAt) || now,
  }
}

function normalizeChoiceQuestion(item) {
  const base = normalizeBaseQuestion(item)
  const options = normalizeStringArray(item.options)
  const optionCount = clampInteger(item.optionCount ?? options.length ?? 4, 2, 8, 4)
  const choiceMode = normalizeChoiceMode(item.choiceMode)

  return {
    ...base,
    type: 'choice',
    choiceMode,
    optionStyle: normalizeOptionStyle(item.optionStyle),
    optionCount,
    options: ensureLength(options, optionCount),
    correctAnswers: sanitizeChoiceAnswers(item.correctAnswers, optionCount),
    analysis: normalizeString(item.analysis),
  }
}

function normalizeChoiceSubQuestion(item) {
  const options = normalizeStringArray(item.options)
  const optionCount = clampInteger(item.optionCount ?? options.length ?? 4, 2, 8, 4)
  const choiceMode = normalizeChoiceMode(item.choiceMode)

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : generateId(),
    stem: normalizeString(item.stem),
    normalizedStem: normalizeString(item.normalizedStem ?? item.stem),
    choiceMode,
    optionStyle: normalizeOptionStyle(item.optionStyle),
    optionCount,
    options: ensureLength(options, optionCount),
    correctAnswers: sanitizeChoiceAnswers(item.correctAnswers, optionCount),
    analysis: normalizeString(item.analysis),
  }
}

function normalizeChoiceGroupQuestion(item) {
  const base = normalizeBaseQuestion(item)
  const rawSubquestions = Array.isArray(item.subquestions) ? item.subquestions : []

  return {
    ...base,
    type: 'choiceGroup',
    subquestions: rawSubquestions
      .map((entry) => (entry && typeof entry === 'object' ? normalizeChoiceSubQuestion(entry) : null))
      .filter(Boolean),
  }
}

function normalizeBlankQuestion(item) {
  const base = normalizeBaseQuestion(item)
  const answers = normalizeStringArray(item.answers)
  const blankCount = clampInteger(
    item.blankCount ?? answers.length ?? 1,
    1,
    20,
    Math.max(1, answers.length || 1),
  )

  return {
    ...base,
    type: 'blank',
    blankCount,
    answers: ensureLength(answers, blankCount),
    analysis: normalizeString(item.analysis),
  }
}

function normalizeSubjectiveQuestion(item) {
  const base = normalizeBaseQuestion(item)
  const answers = normalizeStringArray(item.answers)
  const areaCount = clampInteger(
    item.areaCount ?? answers.length ?? 1,
    1,
    20,
    Math.max(1, answers.length || 1),
  )

  return {
    ...base,
    type: 'subjective',
    areaCount,
    answers: ensureLength(answers, areaCount),
    analysis: normalizeString(item.analysis),
  }
}

function normalizeQuestion(item) {
  if (!item || typeof item !== 'object') {
    return null
  }

  const type = normalizeQuestionType(item.type)
  if (type === 'choice') {
    return normalizeChoiceQuestion(item)
  }
  if (type === 'choiceGroup') {
    return normalizeChoiceGroupQuestion(item)
  }
  if (type === 'blank') {
    return normalizeBlankQuestion(item)
  }

  return normalizeSubjectiveQuestion(item)
}

function normalizeQuestions(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return value.map((item) => normalizeQuestion(item)).filter(Boolean)
}

function extractQuestionsCandidate(raw) {
  if (Array.isArray(raw)) {
    return raw
  }

  if (!raw || typeof raw !== 'object') {
    return null
  }

  if (raw.snapshot && typeof raw.snapshot === 'object') {
    const nested = extractQuestionsCandidate(raw.snapshot)
    if (nested) {
      return nested
    }
  }

  if (raw.data && typeof raw.data === 'object') {
    const nested = extractQuestionsCandidate(raw.data)
    if (nested) {
      return nested
    }
  }

  if (Array.isArray(raw.questions)) {
    return raw.questions
  }

  return null
}

function normalizeQuestionsRecord(raw, exists = true) {
  const source = raw && typeof raw === 'object' ? raw : null
  const questions = normalizeQuestions(extractQuestionsCandidate(raw) || [])
  const updatedAt = source ? normalizeTimestamp(source.updatedAt) : null

  return {
    questions,
    updatedAt,
    exists,
  }
}

function sortQuestions(list) {
  return [...list].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || left.createdAt || '')
    const rightTime = Date.parse(right.updatedAt || right.createdAt || '')
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime)
  })
}

export async function loadQuestionSnapshot() {
  const record = await loadJsonRecord(QUESTIONS_KV_KEY)
  if (!record) {
    return {
      questions: [],
      updatedAt: null,
      exists: false,
    }
  }

  return normalizeQuestionsRecord(record, true)
}

export async function saveQuestionSnapshot(rawInput) {
  const normalized = normalizeQuestionsRecord(rawInput, true)
  const record = {
    questions: sortQuestions(normalized.questions),
    updatedAt: normalized.updatedAt || new Date().toISOString(),
  }

  await saveJsonRecord(QUESTIONS_KV_KEY, record)
  return {
    ...record,
    exists: true,
  }
}

export async function listQuestions(filters = {}) {
  const snapshot = await loadQuestionSnapshot()
  const subject = typeof filters.subject === 'string' ? filters.subject : null
  const type = typeof filters.type === 'string' ? filters.type : null
  const query = typeof filters.query === 'string' ? filters.query.trim().toLowerCase() : ''
  const limit = clampInteger(filters.limit ?? 50, 1, 200, 50)

  const filtered = snapshot.questions.filter((question) => {
    if (subject && question.subject !== subject) {
      return false
    }
    if (type && question.type !== type) {
      return false
    }
    if (!query) {
      return true
    }

    const haystacks =
      question.type === 'choiceGroup'
        ? [
            question.stem,
            ...question.subquestions.flatMap((item) => [
              item.stem,
              item.analysis,
              ...item.options,
            ]),
          ]
        : [
            question.stem,
            question.analysis || '',
            ...(Array.isArray(question.options) ? question.options : []),
            ...(Array.isArray(question.answers) ? question.answers : []),
          ]

    return haystacks.some((item) => normalizeString(item).toLowerCase().includes(query))
  })

  return {
    ...snapshot,
    total: filtered.length,
    questions: filtered.slice(0, limit),
  }
}

export async function getQuestionById(questionId) {
  const normalizedId = typeof questionId === 'string' ? questionId.trim() : ''
  if (!normalizedId) {
    return null
  }

  const snapshot = await loadQuestionSnapshot()
  return snapshot.questions.find((item) => item.id === normalizedId) || null
}

export async function upsertQuestions(rawInput) {
  const incomingArray = Array.isArray(rawInput)
    ? rawInput
    : rawInput && typeof rawInput === 'object' && Array.isArray(rawInput.questions)
      ? rawInput.questions
      : [rawInput]

  const incoming = normalizeQuestions(incomingArray)
  const current = await loadQuestionSnapshot()
  const byId = new Map(current.questions.map((item) => [item.id, item]))

  let created = 0
  let updated = 0

  for (const question of incoming) {
    if (byId.has(question.id)) {
      updated += 1
    } else {
      created += 1
    }
    byId.set(question.id, question)
  }

  const snapshot = await saveQuestionSnapshot({
    questions: sortQuestions([...byId.values()]),
    updatedAt: new Date().toISOString(),
  })

  return {
    snapshot,
    created,
    updated,
  }
}

export async function deleteQuestions(ids) {
  const idSet = new Set(Array.isArray(ids) ? ids.map((item) => normalizeString(item).trim()).filter(Boolean) : [])
  const current = await loadQuestionSnapshot()
  const nextQuestions = current.questions.filter((item) => !idSet.has(item.id))
  const deleted = current.questions.length - nextQuestions.length

  const snapshot = await saveQuestionSnapshot({
    questions: nextQuestions,
    updatedAt: new Date().toISOString(),
  })

  return {
    snapshot,
    deleted,
  }
}
