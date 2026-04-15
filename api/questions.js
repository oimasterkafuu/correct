import { buildJsonResponse, parseRequestJson, requireBearerToken } from './_lib/http.js'
import { loadQuestionSnapshot, saveQuestionSnapshot } from './_lib/questionStore.js'

const QUESTIONS_API_TOKEN = process.env.QUESTION_BANK_API_TOKEN || process.env.MCP_SERVER_TOKEN || ''

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return buildJsonResponse({ ok: true })
  }

  const authError = requireBearerToken(request, QUESTIONS_API_TOKEN)
  if (authError) {
    return authError
  }

  try {
    if (request.method === 'GET') {
      return buildJsonResponse(await loadQuestionSnapshot())
    }

    if (request.method === 'PUT' || request.method === 'POST') {
      const body = await parseRequestJson(request)
      if (!body.ok) {
        return buildJsonResponse({ message: '请求体必须是 JSON。' }, 400)
      }

      return buildJsonResponse(await saveQuestionSnapshot(body.value))
    }

    return buildJsonResponse({ message: '仅支持 GET / PUT / POST / OPTIONS。' }, 405)
  } catch (error) {
    const message = error instanceof Error ? error.message : '题库云端服务异常。'
    return buildJsonResponse({ message }, 500)
  }
}
