import {
  buildEmptyResponse,
  buildJsonResponse,
  getRequestBaseUrl,
  parseRequestJson,
  requireBearerToken,
} from './_lib/http.js'
import {
  callMcpTool,
  getMcpServerMetadata,
  listMcpResourceTemplates,
  listMcpResources,
  listMcpTools,
  readMcpResource,
} from './_lib/mcpRegistry.js'

const MCP_SERVER_TOKEN = process.env.MCP_SERVER_TOKEN || process.env.QUESTION_BANK_API_TOKEN || ''

function buildJsonRpcResult(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  }
}

function buildJsonRpcError(id, code, message) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  }
}

async function dispatchRequest(payload, request) {
  if (!payload || typeof payload !== 'object' || typeof payload.method !== 'string') {
    return buildJsonRpcError(null, -32600, 'Invalid Request')
  }

  const id = 'id' in payload ? payload.id : null
  const params = payload.params && typeof payload.params === 'object' ? payload.params : {}

  if (payload.method === 'initialize') {
    return buildJsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      serverInfo: {
        name: 'correct-mcp',
        version: '1.0.0',
      },
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: 'Use the question tools to read or mutate the shared cloud-backed question bank.',
    })
  }

  if (payload.method === 'ping') {
    return buildJsonRpcResult(id, {})
  }

  if (payload.method === 'tools/list') {
    return buildJsonRpcResult(id, {
      tools: listMcpTools(),
    })
  }

  if (payload.method === 'tools/call') {
    if (typeof params.name !== 'string' || !params.name.trim()) {
      return buildJsonRpcError(id, -32602, 'Missing tool name')
    }

    try {
      const result = await callMcpTool(params.name, params.arguments && typeof params.arguments === 'object' ? params.arguments : {})
      return buildJsonRpcResult(id, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool call failed'
      return buildJsonRpcResult(id, {
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
        isError: true,
      })
    }
  }

  if (payload.method === 'resources/list') {
    return buildJsonRpcResult(id, {
      resources: await listMcpResources(),
    })
  }

  if (payload.method === 'resources/templates/list') {
    return buildJsonRpcResult(id, {
      resourceTemplates: listMcpResourceTemplates(),
    })
  }

  if (payload.method === 'resources/read') {
    if (typeof params.uri !== 'string' || !params.uri.trim()) {
      return buildJsonRpcError(id, -32602, 'Missing resource uri')
    }

    try {
      return buildJsonRpcResult(id, {
        contents: await readMcpResource(params.uri),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Resource read failed'
      return buildJsonRpcError(id, -32002, message)
    }
  }

  if (payload.method === 'prompts/list') {
    return buildJsonRpcResult(id, {
      prompts: [],
    })
  }

  if (payload.method.startsWith('notifications/')) {
    return null
  }

  return buildJsonRpcError(id, -32601, `Method not found: ${payload.method}`)
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return buildJsonResponse({ ok: true })
  }

  const authError = requireBearerToken(request, MCP_SERVER_TOKEN)
  if (authError) {
    return authError
  }

  if (request.method === 'GET') {
    return buildJsonResponse(getMcpServerMetadata(getRequestBaseUrl(request), Boolean(MCP_SERVER_TOKEN)))
  }

  if (request.method !== 'POST') {
    return buildJsonResponse({ message: '仅支持 GET / POST / OPTIONS。' }, 405)
  }

  const body = await parseRequestJson(request)
  if (!body.ok) {
    return buildJsonResponse(buildJsonRpcError(null, -32700, 'Parse error'), 400)
  }

  try {
    const responsePayload = await dispatchRequest(body.value, request)
    if (responsePayload === null) {
      return buildEmptyResponse(202)
    }
    return buildJsonResponse(responsePayload)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MCP 服务异常。'
    return buildJsonResponse(buildJsonRpcError(null, -32603, message), 500)
  }
}
