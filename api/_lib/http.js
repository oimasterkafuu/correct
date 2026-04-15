const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export function buildJsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...BASE_HEADERS,
      ...extraHeaders,
    },
  })
}

export function buildEmptyResponse(status = 204, extraHeaders = {}) {
  return new Response(null, {
    status,
    headers: {
      ...BASE_HEADERS,
      ...extraHeaders,
    },
  })
}

export async function readJsonSafely(response) {
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

export function normalizeTimestamp(value) {
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

export async function parseRequestJson(request) {
  try {
    return {
      ok: true,
      value: await request.json(),
    }
  } catch {
    return {
      ok: false,
      value: null,
    }
  }
}

export function getBearerToken(request) {
  const authorization = request.headers.get('authorization') || request.headers.get('Authorization')
  if (!authorization) {
    return null
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

export function requireBearerToken(request, expectedToken) {
  if (!expectedToken) {
    return null
  }

  const actualToken = getBearerToken(request)
  if (actualToken === expectedToken) {
    return null
  }

  return buildJsonResponse(
    {
      message: '未授权，请提供 Bearer Token。',
    },
    401,
    {
      'WWW-Authenticate': 'Bearer',
    },
  )
}

export function getRequestBaseUrl(request) {
  const url = new URL(request.url)
  return url.origin
}
