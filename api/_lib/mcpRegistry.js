import { SUBJECTS } from './subjects.js'
import {
  deleteQuestions,
  getQuestionById,
  listQuestions,
  loadQuestionSnapshot,
  upsertQuestions,
} from './questionStore.js'

const TOOL_DEFINITIONS = [
  {
    name: 'app_overview',
    description: '查看题库总体概览、题量和最近更新时间。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      const snapshot = await loadQuestionSnapshot()
      const countsByType = snapshot.questions.reduce(
        (acc, question) => {
          acc[question.type] = (acc[question.type] || 0) + 1
          return acc
        },
        {
          choice: 0,
          choiceGroup: 0,
          blank: 0,
          subjective: 0,
        },
      )

      const countsBySubject = snapshot.questions.reduce((acc, question) => {
        acc[question.subject] = (acc[question.subject] || 0) + 1
        return acc
      }, {})

      return {
        content: [
          {
            type: 'text',
            text: `当前题库共 ${snapshot.questions.length} 道题，最近更新时间为 ${snapshot.updatedAt || '未知'}。`,
          },
        ],
        structuredContent: {
          total: snapshot.questions.length,
          updatedAt: snapshot.updatedAt,
          countsByType,
          countsBySubject,
        },
      }
    },
  },
  {
    name: 'subjects_list',
    description: '列出当前系统内置学科信息。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async () => ({
      content: [
        {
          type: 'text',
          text: `当前共支持 ${SUBJECTS.length} 个学科。`,
        },
      ],
      structuredContent: {
        subjects: SUBJECTS,
      },
    }),
  },
  {
    name: 'questions_list',
    description: '按学科、题型或关键词查询题库。',
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: '学科 key，例如 math、english。',
        },
        type: {
          type: 'string',
          description: '题型：choice、choiceGroup、blank、subjective。',
        },
        query: {
          type: 'string',
          description: '按题面、答案、解析模糊匹配。',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: '最多返回多少题，默认 50。',
        },
      },
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const result = await listQuestions(args)
      return {
        content: [
          {
            type: 'text',
            text: `本次返回 ${result.questions.length} 道题，共命中 ${result.total} 道。`,
          },
        ],
        structuredContent: result,
      }
    },
  },
  {
    name: 'question_get',
    description: '按题目 ID 读取单题详情。',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '题目 ID。',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const question = await getQuestionById(args.id)
      if (!question) {
        throw new Error('未找到对应题目。')
      }

      return {
        content: [
          {
            type: 'text',
            text: `已返回题目 ${question.id}。`,
          },
        ],
        structuredContent: {
          question,
        },
      }
    },
  },
  {
    name: 'questions_upsert',
    description: '新增或更新一道或多道题目。',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'object',
          description: '单题对象。',
        },
        questions: {
          type: 'array',
          description: '多题数组。',
          items: {
            type: 'object',
          },
        },
      },
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const payload =
        Array.isArray(args.questions) && args.questions.length > 0
          ? args.questions
          : args.question && typeof args.question === 'object'
            ? [args.question]
            : []

      if (payload.length === 0) {
        throw new Error('请提供 `question` 或 `questions`。')
      }

      const result = await upsertQuestions(payload)
      return {
        content: [
          {
            type: 'text',
            text: `已写入 ${result.created + result.updated} 道题，其中新增 ${result.created} 道，更新 ${result.updated} 道。`,
          },
        ],
        structuredContent: {
          created: result.created,
          updated: result.updated,
          snapshot: result.snapshot,
        },
      }
    },
  },
  {
    name: 'questions_delete',
    description: '按 ID 删除一道或多道题目。',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: {
            type: 'string',
          },
          minItems: 1,
          description: '待删除题目的 ID 列表。',
        },
      },
      required: ['ids'],
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const result = await deleteQuestions(args.ids)
      return {
        content: [
          {
            type: 'text',
            text: `已删除 ${result.deleted} 道题。`,
          },
        ],
        structuredContent: {
          deleted: result.deleted,
          snapshot: result.snapshot,
        },
      }
    },
  },
]

const STATIC_RESOURCES = [
  {
    uri: 'correct://app/overview',
    name: '题库概览',
    description: '题库统计概览。',
    mimeType: 'application/json',
  },
  {
    uri: 'correct://subjects',
    name: '学科列表',
    description: '系统支持的全部学科。',
    mimeType: 'application/json',
  },
  {
    uri: 'correct://questions',
    name: '完整题库',
    description: '当前云端题库快照。',
    mimeType: 'application/json',
  },
]

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'correct://question/{id}',
    name: '单题资源',
    description: '按题目 ID 读取单题 JSON。',
    mimeType: 'application/json',
  },
]

function stringifyResource(data) {
  return JSON.stringify(data, null, 2)
}

export function listMcpTools() {
  return TOOL_DEFINITIONS.map(({ handler, ...tool }) => tool)
}

export async function callMcpTool(name, args = {}) {
  const tool = TOOL_DEFINITIONS.find((item) => item.name === name)
  if (!tool) {
    throw new Error(`未知工具：${name}`)
  }

  return tool.handler(args)
}

export async function listMcpResources() {
  const snapshot = await loadQuestionSnapshot()
  const dynamicResources = snapshot.questions.map((question) => ({
    uri: `correct://question/${encodeURIComponent(question.id)}`,
    name: `${question.id} (${question.type})`,
    description: question.stem.slice(0, 40) || '题面为空',
    mimeType: 'application/json',
  }))

  return [...STATIC_RESOURCES, ...dynamicResources]
}

export function listMcpResourceTemplates() {
  return RESOURCE_TEMPLATES
}

export async function readMcpResource(uri) {
  if (uri === 'correct://subjects') {
    return [
      {
        uri,
        mimeType: 'application/json',
        text: stringifyResource({ subjects: SUBJECTS }),
      },
    ]
  }

  if (uri === 'correct://questions') {
    const snapshot = await loadQuestionSnapshot()
    return [
      {
        uri,
        mimeType: 'application/json',
        text: stringifyResource(snapshot),
      },
    ]
  }

  if (uri === 'correct://app/overview') {
    const snapshot = await loadQuestionSnapshot()
    return [
      {
        uri,
        mimeType: 'application/json',
        text: stringifyResource({
          total: snapshot.questions.length,
          updatedAt: snapshot.updatedAt,
          subjects: SUBJECTS,
        }),
      },
    ]
  }

  const match = uri.match(/^correct:\/\/question\/(.+)$/)
  if (match) {
    const question = await getQuestionById(decodeURIComponent(match[1]))
    if (!question) {
      throw new Error('未找到对应题目资源。')
    }

    return [
      {
        uri,
        mimeType: 'application/json',
        text: stringifyResource({ question }),
      },
    ]
  }

  throw new Error(`未知资源：${uri}`)
}

export function getMcpServerMetadata(baseUrl, authRequired) {
  return {
    name: 'correct-mcp',
    version: '1.0.0',
    protocol: 'MCP over HTTP JSON-RPC',
    endpoint: `${baseUrl}/api/mcp`,
    authRequired,
    capabilities: {
      tools: listMcpTools(),
      staticResources: STATIC_RESOURCES,
      resourceTemplates: RESOURCE_TEMPLATES,
    },
  }
}
