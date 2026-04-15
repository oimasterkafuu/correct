import { readJsonSafely } from './http.js'

const memoryFallback =
  globalThis.__correctMemoryFallback instanceof Map
    ? globalThis.__correctMemoryFallback
    : (globalThis.__correctMemoryFallback = new Map())

export async function callKv(pathname, method = 'GET') {
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

export async function loadJsonRecord(key) {
  const payload = await callKv(`get/${encodeURIComponent(key)}`, 'GET')
  const rawResult = payload && typeof payload === 'object' ? payload.result : null
  if (typeof rawResult !== 'string' || rawResult.trim().length === 0) {
    return null
  }

  try {
    return JSON.parse(rawResult)
  } catch {
    return null
  }
}

export async function saveJsonRecord(key, value) {
  const encoded = encodeURIComponent(JSON.stringify(value))
  await callKv(`set/${encodeURIComponent(key)}/${encoded}`, 'POST')
}
