import { Children, isValidElement, memo, type ReactNode, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

interface MarkdownRendererProps {
  value: string
  className?: string
  allowHtml?: boolean
}

const SAFE_PROTOCOL_REGEX = /^(https?:|mailto:|tel:|blob:)/i
const DATA_IMAGE_REGEX = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/_=-]+$/i
const RELATIVE_URL_REGEX = /^(\/|\.{1,2}\/|#)/
const MARKDOWN_IMAGE_LINE_REGEX = /^!\[[^\]]*]\(([^)\s]+)(\s+"[^"]*")?\)$/
const FENCED_CODE_BLOCK_SPLIT_REGEX = /(```[\s\S]*?```)/g

function joinClassName(...classes: Array<string | undefined>): string | undefined {
  const merged = classes.filter(Boolean).join(' ').trim()
  return merged.length > 0 ? merged : undefined
}

function isImageOnlyParagraph(children: ReactNode): boolean {
  let hasImage = false
  let onlyImageOrWhitespace = true

  Children.forEach(children, (child) => {
    if (!onlyImageOrWhitespace) {
      return
    }

    if (typeof child === 'string') {
      if (child.trim().length === 0) {
        return
      }
      onlyImageOrWhitespace = false
      return
    }

    if (typeof child === 'number') {
      onlyImageOrWhitespace = false
      return
    }

    if (isValidElement(child) && typeof child.type === 'string' && child.type === 'img') {
      hasImage = true
      return
    }

    onlyImageOrWhitespace = false
  })

  return onlyImageOrWhitespace && hasImage
}

function extractImageLines(block: string): string[] | null {
  const lines = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (lines.length === 0) {
    return null
  }

  for (const line of lines) {
    if (!MARKDOWN_IMAGE_LINE_REGEX.test(line)) {
      return null
    }
  }

  return lines
}

function compactMarkdownImageBlocks(markdown: string): string {
  if (!markdown.includes('![') || !markdown.includes('\n\n')) {
    return markdown
  }

  const normalized = markdown.replace(/\r/g, '')
  const blocks = normalized.split(/\n{2,}/)
  if (blocks.length < 2) {
    return normalized
  }

  const merged: string[] = []
  let pendingImages: string[] = []

  const flushPendingImages = () => {
    if (pendingImages.length === 0) {
      return
    }
    merged.push(pendingImages.join('\n'))
    pendingImages = []
  }

  for (const block of blocks) {
    const imageLines = extractImageLines(block)
    if (imageLines) {
      pendingImages.push(...imageLines)
      continue
    }

    flushPendingImages()
    merged.push(block)
  }

  flushPendingImages()
  return merged.join('\n\n')
}

function normalizeMathDelimitersSegment(segment: string): string {
  return segment
    .replace(/\\\[((?:[\s\S]*?))\\\]/g, (_full, expression: string) => `\n$$\n${expression}\n$$\n`)
    .replace(/\\\(((?:[\s\S]*?))\\\)/g, (_full, expression: string) => `$${expression}$`)
}

function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes('\\(') && !markdown.includes('\\[')) {
    return markdown
  }

  const pieces = markdown.split(FENCED_CODE_BLOCK_SPLIT_REGEX)
  return pieces
    .map((piece, index) => (index % 2 === 1 ? piece : normalizeMathDelimitersSegment(piece)))
    .join('')
}

function safeUrlTransform(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) {
    return ''
  }
  if (SAFE_PROTOCOL_REGEX.test(trimmed)) {
    return trimmed
  }
  if (DATA_IMAGE_REGEX.test(trimmed)) {
    return trimmed
  }
  if (RELATIVE_URL_REGEX.test(trimmed)) {
    return trimmed
  }
  if (/^image_\d+$/i.test(trimmed)) {
    return trimmed
  }
  return ''
}

function MarkdownRendererImpl({ value, className, allowHtml = false }: MarkdownRendererProps) {
  const rehypePlugins = useMemo(
    () => (allowHtml ? [rehypeRaw, rehypeKatex] : [rehypeKatex]),
    [allowHtml],
  )
  const renderValue = useMemo(
    () => compactMarkdownImageBlocks(normalizeMathDelimiters(value)),
    [value],
  )

  return (
    <div className={className ?? 'md-renderer'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={rehypePlugins}
        urlTransform={safeUrlTransform}
        components={{
          p: ({ node, className: paragraphClassName, children, ...props }) => {
            void node
            if (isImageOnlyParagraph(children)) {
              return (
                <p {...props} className={joinClassName(paragraphClassName, 'md-image-row')}>
                  {children}
                </p>
              )
            }
            return (
              <p {...props} className={paragraphClassName}>
                {children}
              </p>
            )
          },
          img: ({ node, className: imageClassName, ...props }) => {
            void node
            return (
              <img
                {...props}
                className={joinClassName(imageClassName, 'md-image-item')}
                loading="lazy"
                decoding="async"
              />
            )
          },
        }}
      >
        {renderValue || '（暂无内容）'}
      </ReactMarkdown>
    </div>
  )
}

const MarkdownRenderer = memo(MarkdownRendererImpl)

export default MarkdownRenderer
