import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'

function nodeReqToWebRequest(req: IncomingMessage, body: Buffer): Request {
  const protocol = (req.headers['x-forwarded-proto'] as string) || 'http'
  const host = req.headers.host || 'localhost'
  const url = `${protocol}://${host}${req.url}`
  const method = req.method || 'GET'

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v)
    } else {
      headers.append(key, value)
    }
  }

  return new Request(url, {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : body,
  })
}

async function sendWebResponse(res: ServerResponse, webRes: Response) {
  res.statusCode = webRes.status
  webRes.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })
  const buffer = Buffer.from(await webRes.arrayBuffer())
  res.end(buffer)
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'api-ai-settings-dev',
      configureServer(server) {
        server.middlewares.use('/api/ai-settings', (req, res, next) => {
          const chunks: Buffer[] = []
          req.on('data', (chunk) => chunks.push(chunk))
          req.on('end', async () => {
            try {
              const body = Buffer.concat(chunks)
              const request = nodeReqToWebRequest(req, body)
              const { default: handler } = await import('./api/ai-settings.js')
              const response = await handler(request)
              await sendWebResponse(res, response)
            } catch (err) {
              next(err as Error)
            }
          })
        })
      },
    },
  ],
})
