const DEFAULT_SETTINGS = {
  enabled: true,
  baseUrl: '',
  apiKey: '',
  model: '',
}

const KV_KEY = process.env.AI_SETTINGS_KV_KEY || 'correct:ai-settings:v1'

const memoryFallback = new Map()

function normalizeSettings(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_SETTINGS }
  }

  const source = raw
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl.trim() : '',
    apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim() : '',
    model: typeof source.model === 'string' ? source.model.trim() : '',
  }
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  const timestamp = Date.parse(trimmed)
  if (Number.isNaN(timestamp)) {
    return null
  }

  return new Date(timestamp).toISOString()
}

function normalizeSettingsRecord(raw, exists = true) {
  if (!raw || typeof raw !== 'object') {
    return {
      settings: { ...DEFAULT_SETTINGS },
      updatedAt: null,
      exists,
    }
  }

  const source = raw
  if (source.settings && typeof source.settings === 'object') {
    return {
      settings: normalizeSettings(source.settings),
      updatedAt: normalizeTimestamp(source.updatedAt),
      exists,
    }
  }

  return {
    settings: normalizeSettings(source),
    updatedAt: null,
    exists,
  }
}

function buildJsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  })
}

async function readJsonSafely(response) {
  const text = (await response.text()).trim()
  if (!text) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function callKv(pathname, method = 'GET') {
  const baseUrl = process.env.KV_REST_API_URL
  const token = process.env.KV_REST_API_TOKEN
  if (!baseUrl || !token) {
    const getMatch = pathname.match(/^get\/(.+)$/)
    if (getMatch) {
      const key = decodeURIComponent(getMatch[1])
      const value = memoryFallback.get(key) ?? null
      return { result: value }
    }
    const setMatch = pathname.match(/^set\/([^/]+)\/(.+)$/)
    if (setMatch) {
      const key = decodeURIComponent(setMatch[1])
      const value = decodeURIComponent(setMatch[2])
      memoryFallback.set(key, value)
      return { result: 'OK' }
    }
    throw new Error('KV 未配置：请设置 KV_REST_API_URL 与 KV_REST_API_TOKEN。')
  }

  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  const normalizedPath = pathname.replace(/^\/+/, '')
  const response = await fetch(`${normalizedBaseUrl}/${normalizedPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  const payload = await readJsonSafely(response)
  if (!response.ok) {
    const message =
      payload && typeof payload.message === 'string'
        ? payload.message
        : `KV 请求失败（HTTP ${response.status}）`
    throw new Error(message)
  }

  return payload
}

async function loadSettingsFromKv() {
  const payload = await callKv(`get/${encodeURIComponent(KV_KEY)}`, 'GET')
  const rawResult = payload && typeof payload === 'object' ? payload.result : null
  if (typeof rawResult !== 'string' || rawResult.trim().length === 0) {
    return {
      settings: { ...DEFAULT_SETTINGS },
      updatedAt: null,
      exists: false,
    }
  }

  try {
    return normalizeSettingsRecord(JSON.parse(rawResult), true)
  } catch {
    return {
      settings: { ...DEFAULT_SETTINGS },
      updatedAt: null,
      exists: false,
    }
  }
}

async function saveSettingsToKv(rawInput) {
  const normalized = normalizeSettingsRecord(rawInput, true)
  const record = {
    settings: normalized.settings,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
  }
  const encoded = encodeURIComponent(JSON.stringify(record))
  await callKv(`set/${encodeURIComponent(KV_KEY)}/${encoded}`, 'POST')
  return {
    ...record,
    exists: true,
  }
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return buildJsonResponse({ ok: true })
  }

  try {
    if (request.method === 'GET') {
      const settings = await loadSettingsFromKv()
      return buildJsonResponse(settings)
    }

    if (request.method === 'PUT' || request.method === 'POST') {
      let body
      try {
        body = await request.json()
      } catch {
        return buildJsonResponse({ message: '请求体必须是 JSON。' }, 400)
      }

      const settings = await saveSettingsToKv(body)
      return buildJsonResponse(settings)
    }

    return buildJsonResponse({ message: '仅支持 GET / PUT / POST / OPTIONS。' }, 405)
  } catch (error) {
    const message = error instanceof Error ? error.message : '云端配置服务异常。'
    return buildJsonResponse({ message }, 500)
  }
}
