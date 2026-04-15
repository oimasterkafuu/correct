import { alphaLabel, countAreaTokens, countInlineTokens, migrateStemTokens } from './questionUtils'
import {
  DEFAULT_PDF_EXPORT_SPACING_CONFIG,
  type PdfExportSpacingConfig,
} from './pdfExportConfig'
import type { ChoiceSubQuestion, Question } from '../types'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { toMarkdown } from 'mdast-util-to-markdown'

const INLINE_TOKEN_REGEX = /\[\[INLINE_BLANK_(\d+)\]\]/g
const AREA_TOKEN_REGEX = /\[\[AREA_BLANK_(\d+)\]\]/g
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g

const CHOICE_BLANK_TEXT = '（    ）'
const FILL_BLANK_TEXT = '__________'
const CORRECT_OPTION_COLOR = '#2f5d50'
const TABLE_BORDER_COLOR = '#aab5c3'
const TABLE_HEADER_FILL_COLOR = '#eef3f8'
const TABLE_CELL_HORIZONTAL_PADDING_PX = mmToPx(1.4)
const TABLE_CELL_VERTICAL_PADDING_PX = mmToPx(0.9)
const TABLE_MIN_COLUMN_WIDTH_PX = mmToPx(14)
const BLOCKQUOTE_MARKER = '▍ '
const CODE_FONT_FAMILY =
  '"SFMono-Regular", "Consolas", "Liberation Mono", "Menlo", monospace'

const PAGE_WIDTH_MM = 182
const PAGE_HEIGHT_MM = 257
const PAGE_MARGIN_MM = 8
const COLUMN_GAP_MM = 6
const PX_PER_MM = 10
const LOOSE_LEAF_HOLE_COUNT = 26
const LOOSE_LEAF_HOLE_PITCH_MM = 9.5
const LOOSE_LEAF_HOLE_DIAMETER_MM = 5.5
const LOOSE_LEAF_HOLE_OFFSET_MM = 6.25

const QUESTION_FONT_FAMILY =
  '"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
const ANALYSIS_FONT_FAMILY =
  '"STKaiti", "Kaiti SC", "KaiTi", "Noto Serif SC", "Songti SC", "SimSun", serif'
const BASE_FONT_SIZE = mmToPx(3.4)
const ANALYSIS_FONT_SIZE = mmToPx(3)
const LINE_HEIGHT_RATIO = 1.5
const NODE_GAP_PX = mmToPx(1.4)
const IMAGE_ROW_GAP_PX = mmToPx(1.6)
const IMAGE_PLACEHOLDER_HEIGHT_PX = mmToPx(30)
const IMAGE_MAX_HEIGHT_PX = mmToPx(60)
const IMAGE_MIN_HEIGHT_PX = mmToPx(16)
const IMAGE_FALLBACK_RATIO = 1.4
const QUESTION_MARKER_SCALE = 1.42
const QUESTION_MARKER_GAP_PX = mmToPx(1.2)
const MATH_RENDER_FONT_SIZE = 40
const KATEX_DEFAULT_EM_SCALE = 1.21
const INLINE_MATH_ASCENT_SHIFT_EM = 0.08
const QUESTION_INLINE_MATH_EXTRA_SHIFT_EM = 0.08
const INLINE_MATH_MAX_HEIGHT_RATIO = 0.92
const DISPLAY_MATH_COMPACT_RATIO = 0.94

const CIRCLE_LABELS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']
const NO_LINE_START_CHARS =
  '，。！？；：、,.!?;:)]｝〕〉》」』】】”’％%…'
const NO_LINE_END_CHARS = '([｛〔〈《「『【“‘'

type RenderNode =
  | {
      type: 'text'
      text: string
      fontSize: number
      bold?: boolean
      fontFamily?: string
      color?: string
    }
  | {
      type: 'richText'
      segments: RichTextSegment[]
      fontSize: number
      bold?: boolean
      fontFamily?: string
      color?: string
    }
  | {
      type: 'richTextLines'
      lines: RichTextLine[]
      fontSize: number
      bold?: boolean
      fontFamily?: string
      color?: string
    }
  | {
      type: 'table'
      rows: RenderTableRow[]
      fontSize: number
      bold?: boolean
      fontFamily?: string
      color?: string
      headerRowCount: number
    }
  | {
      type: 'image'
      src: string
      alt: string
    }
  | {
      type: 'markedText'
      marker: string
      text: string
      fontSize: number
      bold?: boolean
      fontFamily?: string
      color?: string
      markerScale?: number
    }
  | {
      type: 'choiceStem'
      text: string
      trailingBlank: string
      fontSize: number
      bold?: boolean
      fontFamily?: string
      color?: string
      leadText?: string
      leadFontScale?: number
      leadGapPx?: number
      leadBold?: boolean
    }
  | {
      type: 'imageRow'
      images: Array<{
        src: string
        alt: string
      }>
    }
  | {
      type: 'space'
      heightMm: number
    }

interface RenderBlock {
  nodes: RenderNode[]
  heightPx: number
}

interface RenderPlan {
  type: Question['type']
  blocks: RenderBlock[]
  totalHeightPx: number
}

interface PageState {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  columnY: [number, number]
  leftX: number
  rightX: number
  dividerX: number
  bindingSide: 'left' | 'right'
}

interface TextNodeStyle {
  fontSize?: number
  bold?: boolean
  fontFamily?: string
  color?: string
}

interface MarkdownSplitResult {
  textMarkdown: string
  images: Array<{
    src: string
    alt: string
  }>
}

interface MathAsset {
  canvas: HTMLCanvasElement
  width: number
  height: number
  baseFontSize: number
}

interface RenderMathToken {
  type: 'math'
  key: string
  displayMode: boolean
  width: number
  height: number
  latex: string
}

interface RenderTextToken {
  type: 'text'
  text: string
  width: number
  height: number
  fontWeight: number
  fontFamily: string
  color: string
}

type RenderInlineToken = RenderMathToken | RenderTextToken
type RenderInlineNode = RenderInlineToken | { type: 'lineBreak' }

interface RichTextLine {
  tokens: RenderInlineToken[]
  width: number
  height: number
}

type RichTextSegment =
  | {
      type: 'text'
      text: string
      bold?: boolean
      fontFamily?: string
      color?: string
    }
  | {
      type: 'math'
      latex: string
      displayMode: boolean
    }
  | {
      type: 'lineBreak'
    }

interface RenderTableRow {
  cells: RichTextSegment[][]
}

function trimCanvasTransparentPadding(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return canvas
  }

  const { width, height } = canvas
  if (width <= 0 || height <= 0) {
    return canvas
  }

  const imageData = ctx.getImageData(0, 0, width, height)
  const data = imageData.data

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3]
      if (alpha > 0) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return canvas
  }

  const cropWidth = maxX - minX + 1
  const cropHeight = maxY - minY + 1
  if (cropWidth <= 0 || cropHeight <= 0) {
    return canvas
  }

  if (cropWidth === width && cropHeight === height) {
    return canvas
  }

  const cropped = document.createElement('canvas')
  cropped.width = cropWidth
  cropped.height = cropHeight
  const croppedCtx = cropped.getContext('2d')
  if (!croppedCtx) {
    return canvas
  }
  croppedCtx.drawImage(canvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
  return cropped
}

function mmToPx(mm: number): number {
  return mm * PX_PER_MM
}

function buildOptionMarker(index: number, style: 'latin' | 'circle'): string {
  if (style === 'circle') {
    return CIRCLE_LABELS[index] ?? `(${index + 1})`
  }
  return alphaLabel(index)
}

function buildQuestionMarker(question: Question): string {
  if (question.type === 'subjective') {
    return '✦'
  }
  if (question.type === 'blank') {
    return '✧'
  }
  if (question.type === 'choiceGroup') {
    return '✦'
  }
  return question.choiceMode === 'single' ? '✧' : '✦'
}

function splitSubjectiveStem(stem: string, expectedCount: number): {
  segments: string[]
  tail: string
} {
  const segments: string[] = []
  let lastIndex = 0
  let tokenCount = 0

  for (const match of stem.matchAll(AREA_TOKEN_REGEX)) {
    const index = match.index ?? 0
    segments.push(stem.slice(lastIndex, index))
    lastIndex = index + match[0].length
    tokenCount += 1
  }

  if (tokenCount === 0) {
    return {
      segments: [stem],
      tail: '',
    }
  }

  const tail = stem.slice(lastIndex)
  const needed = Math.max(tokenCount, expectedCount)

  while (segments.length < needed) {
    segments.push('')
  }

  return {
    segments,
    tail,
  }
}

function normalizeMathDelimiters(markdown: string): string {
  return markdown
    .replace(/\\\[((?:[\s\S]*?))\\\]/g, (_full, expression: string) => `\n$$\n${expression}\n$$\n`)
    .replace(/\\\(((?:[\s\S]*?))\\\)/g, (_full, expression: string) => `$${expression}$`)
}

function getMathKey(latex: string, displayMode: boolean): string {
  return `${displayMode ? 'D' : 'I'}:${latex.trim()}`
}

function collectMathExpressions(
  markdown: string,
  target: Map<string, { latex: string; displayMode: boolean }>,
) {
  if (!markdown.includes('$') && !markdown.includes('\\(') && !markdown.includes('\\[')) {
    return
  }

  const normalized = normalizeMathDelimiters(markdown)

  const withoutDisplay = normalized.replace(/\$\$([\s\S]*?)\$\$/g, (_full, expression: string) => {
    const latex = expression.trim()
    if (latex.length > 0) {
      target.set(getMathKey(latex, true), { latex, displayMode: true })
    }
    return '\n'
  })

  withoutDisplay.replace(/\$([^$\n]+?)\$/g, (_full, expression: string) => {
    const latex = expression.trim()
    if (latex.length > 0) {
      target.set(getMathKey(latex, false), { latex, displayMode: false })
    }
    return ''
  })
}

function normalizeMarkdownText(markdown: string): string {
  return normalizeMathDelimiters(markdown)
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/~~/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function pushTextSegment(
  target: RichTextSegment[],
  text: string,
  style: {
    bold?: boolean
    fontFamily?: string
    color?: string
  },
) {
  if (text.length === 0) {
    return
  }

  const last = target[target.length - 1]
  if (
    last?.type === 'text' &&
    last.bold === style.bold &&
    last.fontFamily === style.fontFamily &&
    last.color === style.color
  ) {
    last.text += text
    return
  }

  target.push({
    type: 'text',
    text,
    bold: style.bold,
    fontFamily: style.fontFamily,
    color: style.color,
  })
}

function pushLineBreakSegment(target: RichTextSegment[]) {
  const last = target[target.length - 1]
  if (last?.type === 'lineBreak') {
    return
  }
  target.push({ type: 'lineBreak' })
}

function compactRichTextSegments(segments: RichTextSegment[]): RichTextSegment[] {
  const result: RichTextSegment[] = []

  segments.forEach((segment) => {
    if (segment.type === 'lineBreak') {
      pushLineBreakSegment(result)
      return
    }

    if (segment.type === 'math') {
      result.push(segment)
      return
    }

    pushTextSegment(result, segment.text, {
      bold: segment.bold,
      fontFamily: segment.fontFamily,
      color: segment.color,
    })
  })

  while (result[0]?.type === 'lineBreak') {
    result.shift()
  }
  while (result[result.length - 1]?.type === 'lineBreak') {
    result.pop()
  }

  return result
}

function extractInlineSegments(
  nodes: Array<Record<string, unknown>>,
  style: {
    bold?: boolean
    fontFamily?: string
    color?: string
  } = {},
): RichTextSegment[] {
  const segments: RichTextSegment[] = []

  const visitNode = (
    node: Record<string, unknown>,
    inheritedStyle: {
      bold?: boolean
      fontFamily?: string
      color?: string
    },
  ) => {
    const nodeType = typeof node.type === 'string' ? node.type : ''

    if (nodeType === 'text') {
      pushTextSegment(segments, typeof node.value === 'string' ? node.value : '', inheritedStyle)
      return
    }

    if (nodeType === 'strong') {
      const children = Array.isArray(node.children) ? (node.children as Array<Record<string, unknown>>) : []
      children.forEach((child) => visitNode(child, { ...inheritedStyle, bold: true }))
      return
    }

    if (
      nodeType === 'emphasis' ||
      nodeType === 'delete' ||
      nodeType === 'link' ||
      nodeType === 'linkReference'
    ) {
      const children = Array.isArray(node.children) ? (node.children as Array<Record<string, unknown>>) : []
      children.forEach((child) => visitNode(child, inheritedStyle))
      return
    }

    if (nodeType === 'inlineCode') {
      pushTextSegment(segments, typeof node.value === 'string' ? node.value : '', {
        ...inheritedStyle,
        fontFamily: CODE_FONT_FAMILY,
      })
      return
    }

    if (nodeType === 'inlineMath') {
      const latex = typeof node.value === 'string' ? node.value.trim() : ''
      if (latex.length > 0) {
        segments.push({
          type: 'math',
          latex,
          displayMode: false,
        })
      }
      return
    }

    if (nodeType === 'break') {
      pushLineBreakSegment(segments)
      return
    }

    if (nodeType === 'image') {
      const alt = typeof node.alt === 'string' && node.alt.trim().length > 0 ? node.alt.trim() : '图片'
      pushTextSegment(segments, alt, inheritedStyle)
      return
    }

    if (Array.isArray(node.children)) {
      ;(node.children as Array<Record<string, unknown>>).forEach((child) => visitNode(child, inheritedStyle))
      return
    }

    if (typeof node.value === 'string') {
      pushTextSegment(segments, normalizeMarkdownText(node.value), inheritedStyle)
    }
  }

  nodes.forEach((node) => visitNode(node, style))
  return compactRichTextSegments(segments)
}

function buildRichTextNode(
  segments: RichTextSegment[],
  textStyle: Required<TextNodeStyle>,
): RenderNode[] {
  const compacted = compactRichTextSegments(segments)
  if (compacted.length === 0) {
    return []
  }

  return [
    {
      type: 'richText',
      segments: compacted,
      fontSize: textStyle.fontSize,
      bold: textStyle.bold,
      fontFamily: textStyle.fontFamily,
      color: textStyle.color,
    },
  ]
}

function isWhitespaceOnlyMdastNode(node: Record<string, unknown>): boolean {
  return node.type === 'text' && typeof node.value === 'string' && node.value.trim().length === 0
}

function extractParagraphImages(node: Record<string, unknown>): Array<{ src: string; alt: string }> | null {
  if (node.type !== 'paragraph' || !Array.isArray(node.children)) {
    return null
  }

  const images: Array<{ src: string; alt: string }> = []

  for (const child of node.children as Array<Record<string, unknown>>) {
    if (child.type === 'image') {
      const url = typeof child.url === 'string' ? child.url : ''
      if (url.trim().length === 0) {
        return null
      }
      images.push({
        src: resolveImageUrl(url),
        alt: typeof child.alt === 'string' && child.alt.trim().length > 0 ? child.alt.trim() : '图片',
      })
      continue
    }

    if (!isWhitespaceOnlyMdastNode(child)) {
      return null
    }
  }

  return images.length > 0 ? images : null
}

function listItemToSegments(
  node: Record<string, unknown>,
  marker: string,
): RichTextSegment[] {
  const segments: RichTextSegment[] = []
  pushTextSegment(segments, marker, { bold: true })

  const children = Array.isArray(node.children) ? (node.children as Array<Record<string, unknown>>) : []
  let hasContent = false

  children.forEach((child, index) => {
    if (index > 0 && segments[segments.length - 1]?.type !== 'lineBreak') {
      pushLineBreakSegment(segments)
    }

    if (child.type === 'paragraph' && Array.isArray(child.children)) {
      segments.push(...extractInlineSegments(child.children as Array<Record<string, unknown>>))
      hasContent = true
      return
    }

    if (child.type === 'math' && typeof child.value === 'string' && child.value.trim().length > 0) {
      segments.push({
        type: 'math',
        latex: child.value.trim(),
        displayMode: true,
      })
      hasContent = true
      return
    }

    const fallback = normalizeMarkdownText(toMarkdown(child as never))
    if (fallback.length > 0) {
      pushTextSegment(segments, fallback, {})
      hasContent = true
    }
  })

  return hasContent ? compactRichTextSegments(segments) : []
}

function parseMarkdownTextToNodes(markdown: string, textStyle: Required<TextNodeStyle>): RenderNode[] {
  const normalized = normalizeMathDelimiters(markdown).replace(/\r/g, '').trim()
  if (normalized.length === 0) {
    return []
  }

  let tree: { children?: Array<Record<string, unknown>> } | null = null
  try {
    tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(normalized) as unknown as {
      children?: Array<Record<string, unknown>>
    }
  } catch {
    tree = null
  }

  if (!tree?.children) {
    return buildRichTextNode(
      [
        {
          type: 'text',
          text: normalizeMarkdownText(normalized),
        },
      ],
      textStyle,
    )
  }

  const nodes: RenderNode[] = []

  tree.children.forEach((child) => {
    const images = extractParagraphImages(child)
    if (images) {
      if (images.length === 1) {
        nodes.push({
          type: 'image',
          src: images[0].src,
          alt: images[0].alt,
        })
      } else {
        nodes.push({
          type: 'imageRow',
          images,
        })
      }
      return
    }

    if (child.type === 'paragraph') {
      const paragraphChildren = Array.isArray(child.children)
        ? (child.children as Array<Record<string, unknown>>)
        : []
      nodes.push(...buildRichTextNode(extractInlineSegments(paragraphChildren), textStyle))
      return
    }

    if (child.type === 'heading') {
      const headingChildren = Array.isArray(child.children)
        ? (child.children as Array<Record<string, unknown>>)
        : []
      nodes.push(
        ...buildRichTextNode(extractInlineSegments(headingChildren, { bold: true }), {
          ...textStyle,
          fontSize: textStyle.fontSize * 1.06,
          bold: true,
        }),
      )
      return
    }

    if (child.type === 'list') {
      const start = typeof child.start === 'number' ? child.start : 1
      const ordered = child.ordered === true
      const items = Array.isArray(child.children) ? (child.children as Array<Record<string, unknown>>) : []
      items.forEach((item, index) => {
        const marker = ordered ? `${start + index}. ` : '• '
        nodes.push(...buildRichTextNode(listItemToSegments(item, marker), textStyle))
      })
      return
    }

    if (child.type === 'blockquote') {
      const quoteChildren = Array.isArray(child.children) ? (child.children as Array<Record<string, unknown>>) : []
      quoteChildren.forEach((quoteChild, index) => {
        const quoteMarkdown = normalizeMarkdownText(toMarkdown(quoteChild as never))
        if (quoteMarkdown.length === 0) {
          return
        }
        const segments: RichTextSegment[] = []
        pushTextSegment(segments, index === 0 ? BLOCKQUOTE_MARKER : '  ', {
          bold: true,
          color: textStyle.color,
        })
        pushTextSegment(segments, quoteMarkdown, {})
        nodes.push(...buildRichTextNode(segments, textStyle))
      })
      return
    }

    if (child.type === 'code') {
      const value = typeof child.value === 'string' ? child.value : ''
      nodes.push(
        ...buildRichTextNode(
          [
            {
              type: 'text',
              text: value,
              fontFamily: CODE_FONT_FAMILY,
            },
          ],
          textStyle,
        ),
      )
      return
    }

    if (child.type === 'math') {
      const latex = typeof child.value === 'string' ? child.value.trim() : ''
      if (latex.length > 0) {
        nodes.push(
          ...buildRichTextNode(
            [
              {
                type: 'math',
                latex,
                displayMode: true,
              },
            ],
            textStyle,
          ),
        )
      }
      return
    }

    if (child.type === 'table') {
      const rows = Array.isArray(child.children) ? (child.children as Array<Record<string, unknown>>) : []
      const tableRows: RenderTableRow[] = rows
        .map((row, rowIndex) => {
          const cells = Array.isArray(row.children) ? (row.children as Array<Record<string, unknown>>) : []
          return {
            cells: cells.map((cell) =>
              extractInlineSegments(
                Array.isArray(cell.children) ? (cell.children as Array<Record<string, unknown>>) : [],
                {
                  bold: rowIndex === 0,
                },
              ),
            ),
          }
        })
        .filter((row) => row.cells.length > 0)

      if (tableRows.length > 0) {
        nodes.push({
          type: 'table',
          rows: tableRows,
          headerRowCount: 1,
          fontSize: textStyle.fontSize,
          bold: textStyle.bold,
          fontFamily: textStyle.fontFamily,
          color: textStyle.color,
        })
      }
      return
    }

    const fallback = normalizeMarkdownText(toMarkdown(child as never))
    if (fallback.length > 0) {
      nodes.push(
        ...buildRichTextNode(
          [
            {
              type: 'text',
              text: fallback,
            },
          ],
          textStyle,
        ),
      )
    }
  })

  return nodes
}

function resolveImageUrl(src: string): string {
  const raw = src.trim()
  if (raw.startsWith('data:') || raw.startsWith('blob:')) return raw
  try {
    return new URL(raw, window.location.href).toString()
  } catch {
    return raw
  }
}

function splitMarkdownTextAndImages(markdown: string): MarkdownSplitResult {
  const images: MarkdownSplitResult['images'] = []
  const textChunks: string[] = []
  let cursor = 0

  for (const match of markdown.matchAll(MARKDOWN_IMAGE_REGEX)) {
    const index = match.index ?? 0
    const before = markdown.slice(cursor, index).trim()
    if (before.length > 0) {
      textChunks.push(before)
    }
    images.push({
      src: resolveImageUrl(match[2]),
      alt: match[1] || '图片',
    })
    cursor = index + match[0].length
  }

  const tail = markdown.slice(cursor).trim()
  if (tail.length > 0) {
    textChunks.push(tail)
  }

  return {
    textMarkdown: textChunks.join('\n\n'),
    images,
  }
}

function getImageRatio(image: HTMLImageElement | null): number {
  if (!image || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return IMAGE_FALLBACK_RATIO
  }
  return image.naturalWidth / image.naturalHeight
}

function buildChoiceLikeImageRows(
  images: Array<{ src: string; alt: string }>,
): RenderNode[] {
  if (images.length === 0) {
    return []
  }
  return [
    {
      type: 'imageRow',
      images,
    },
  ]
}

function prependQuestionMarkerToNodes(marker: string, nodes: RenderNode[]): RenderNode[] {
  const markerSegment: RichTextSegment = {
    type: 'text',
    text: `${marker} `,
    bold: true,
  }

  if (nodes.length === 0) {
    return [
      {
        type: 'richText',
        segments: [markerSegment],
        fontSize: BASE_FONT_SIZE,
        fontFamily: QUESTION_FONT_FAMILY,
        color: '#1e2430',
      },
    ]
  }

  const first = nodes[0]
  if (first.type === 'text') {
    return [
      {
        ...first,
        text: `${marker} ${first.text}`,
        fontSize: first.fontSize,
        bold: first.bold,
        fontFamily: first.fontFamily,
        color: first.color,
      },
      ...nodes.slice(1),
    ]
  }

  if (first.type === 'richText') {
    return [
      {
        ...first,
        segments: compactRichTextSegments([markerSegment, ...first.segments]),
      },
      ...nodes.slice(1),
    ]
  }

  return [
    {
      type: 'richText',
      segments: [markerSegment],
      fontSize: BASE_FONT_SIZE,
      fontFamily: QUESTION_FONT_FAMILY,
      color: '#1e2430',
    },
    ...nodes,
  ]
}

function markdownToNodes(markdown: string, textStyle?: TextNodeStyle): RenderNode[] {
  const resolvedStyle: Required<TextNodeStyle> = {
    fontSize: textStyle?.fontSize ?? BASE_FONT_SIZE,
    bold: textStyle?.bold ?? false,
    fontFamily: textStyle?.fontFamily ?? QUESTION_FONT_FAMILY,
    color: textStyle?.color ?? '#1e2430',
  }
  const nodes: RenderNode[] = []
  let cursor = 0

  for (const match of markdown.matchAll(MARKDOWN_IMAGE_REGEX)) {
    const index = match.index ?? 0
    nodes.push(...parseMarkdownTextToNodes(markdown.slice(cursor, index), resolvedStyle))

    nodes.push({
      type: 'image',
      src: resolveImageUrl(match[2]),
      alt: match[1] || '图片',
    })
    cursor = index + match[0].length
  }

  nodes.push(...parseMarkdownTextToNodes(markdown.slice(cursor), resolvedStyle))

  return nodes
}

function prependLabelToNodes(label: string, nodes: RenderNode[], textStyle?: TextNodeStyle): RenderNode[] {
  const resolvedStyle: Required<TextNodeStyle> = {
    fontSize: textStyle?.fontSize ?? BASE_FONT_SIZE,
    bold: textStyle?.bold ?? false,
    fontFamily: textStyle?.fontFamily ?? QUESTION_FONT_FAMILY,
    color: textStyle?.color ?? '#1e2430',
  }
  const labelSegment: RichTextSegment = {
    type: 'text',
    text: label,
    bold: resolvedStyle.bold,
    fontFamily: resolvedStyle.fontFamily,
    color: resolvedStyle.color,
  }

  if (nodes.length === 0) {
    return [
      {
        type: 'richText',
        segments: [labelSegment],
        fontSize: resolvedStyle.fontSize,
        bold: resolvedStyle.bold,
        fontFamily: resolvedStyle.fontFamily,
        color: resolvedStyle.color,
      },
    ]
  }

  const first = nodes[0]
  if (first.type === 'text') {
    return [
      {
        ...first,
        text: `${label}${first.text}`,
      },
      ...nodes.slice(1),
    ]
  }

  if (first.type === 'richText') {
    return [
      {
        ...first,
        segments: compactRichTextSegments([labelSegment, ...first.segments]),
      },
      ...nodes.slice(1),
    ]
  }

  return [
    {
      type: 'richText',
      segments: [labelSegment],
      fontSize: resolvedStyle.fontSize,
      bold: resolvedStyle.bold,
      fontFamily: resolvedStyle.fontFamily,
      color: resolvedStyle.color,
    },
    ...nodes,
  ]
}

function buildAnalysisNodes(analysisMarkdown: string): RenderNode[] {
  return markdownToNodes(analysisMarkdown, {
    fontSize: ANALYSIS_FONT_SIZE,
    fontFamily: ANALYSIS_FONT_FAMILY,
    color: '#2f3a4c',
  })
}

function collectImageSources(questions: Question[], includeAnalysis: boolean): string[] {
  const result = new Set<string>()

  const consume = (markdown: string) => {
    for (const match of markdown.matchAll(MARKDOWN_IMAGE_REGEX)) {
      result.add(resolveImageUrl(match[2]))
    }
  }

  for (const question of questions) {
    consume(question.stem)
    if (question.type === 'choice') {
      for (const option of question.options) {
        consume(option)
      }
    }
    if (question.type === 'choiceGroup') {
      for (const subquestion of question.subquestions) {
        consume(subquestion.stem)
        for (const option of subquestion.options) {
          consume(option)
        }
        if (includeAnalysis && subquestion.analysis.trim().length > 0) {
          consume(subquestion.analysis)
        }
      }
    }

    if (question.type !== 'choiceGroup' && includeAnalysis && question.analysis.trim().length > 0) {
      consume(question.analysis)
    }
  }

  return [...result]
}

async function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.decoding = 'async'
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = src
  })
}

async function buildImageMap(
  questions: Question[],
  includeAnalysis: boolean,
): Promise<Map<string, HTMLImageElement | null>> {
  const sources = collectImageSources(questions, includeAnalysis)
  const entries = await Promise.all(
    sources.map(async (src) => {
      const image = await loadImage(src)
      return [src, image] as const
    }),
  )
  return new Map(entries)
}

function collectMathSources(
  questions: Question[],
  includeAnalysis: boolean,
): Array<{ key: string; latex: string; displayMode: boolean }> {
  const expressions = new Map<string, { latex: string; displayMode: boolean }>()

  const consume = (markdown: string) => {
    collectMathExpressions(markdown, expressions)
  }

  for (const question of questions) {
    consume(question.stem)
    consume(question.normalizedStem)

    if (question.type === 'choice') {
      for (const option of question.options) {
        consume(option)
      }
    }
    if (question.type === 'choiceGroup') {
      for (const subquestion of question.subquestions) {
        consume(subquestion.stem)
        consume(subquestion.normalizedStem)
        for (const option of subquestion.options) {
          consume(option)
        }
        if (includeAnalysis && subquestion.analysis.trim().length > 0) {
          consume(subquestion.analysis)
        }
      }
    }

    if (question.type !== 'choiceGroup' && includeAnalysis && question.analysis.trim().length > 0) {
      consume(question.analysis)
    }
  }

  return [...expressions.entries()].map(([key, value]) => ({
    key,
    latex: value.latex,
    displayMode: value.displayMode,
  }))
}

async function buildMathAssetMap(
  questions: Question[],
  includeAnalysis: boolean,
): Promise<Map<string, MathAsset | null>> {
  const sources = collectMathSources(questions, includeAnalysis)
  if (sources.length === 0) {
    return new Map()
  }

  const [{ default: html2canvas }, katexModule] = await Promise.all([
    import('html2canvas'),
    import('katex'),
  ])
  const katex = katexModule.default

  const host = document.createElement('div')
  host.style.position = 'fixed'
  host.style.left = '-100000px'
  host.style.top = '0'
  host.style.pointerEvents = 'none'
  host.style.opacity = '0'
  host.style.zIndex = '-1'
  document.body.appendChild(host)

  const assetMap = new Map<string, MathAsset | null>()

  try {
    for (const source of sources) {
      const wrapper = document.createElement('div')
      wrapper.style.display = 'inline-block'
      wrapper.style.background = 'transparent'
      wrapper.style.padding = '0'
      wrapper.style.margin = '0'
      wrapper.style.fontSize = `${MATH_RENDER_FONT_SIZE}px`
      wrapper.style.color = '#1e2430'
      wrapper.style.whiteSpace = 'nowrap'
      wrapper.style.textAlign = 'left'
      wrapper.style.width = 'fit-content'
      wrapper.innerHTML = katex.renderToString(source.latex, {
        throwOnError: false,
        displayMode: source.displayMode,
      })

      const displayNode = wrapper.querySelector('.katex-display') as HTMLElement | null
      if (displayNode) {
        displayNode.style.margin = '0'
        displayNode.style.display = 'inline-block'
        displayNode.style.width = 'fit-content'
        displayNode.style.textAlign = 'left'
      }

      const katexNode = wrapper.querySelector('.katex') as HTMLElement | null
      if (katexNode) {
        katexNode.style.textAlign = 'left'
      }

      host.appendChild(wrapper)

      try {
        const rawCanvas = await html2canvas(wrapper, {
          backgroundColor: null,
          scale: 2,
          logging: false,
          useCORS: true,
        })
        const canvas = trimCanvasTransparentPadding(rawCanvas)

        if (canvas.width > 0 && canvas.height > 0) {
          assetMap.set(source.key, {
            canvas,
            width: canvas.width,
            height: canvas.height,
            baseFontSize: MATH_RENDER_FONT_SIZE * KATEX_DEFAULT_EM_SCALE * 2,
          })
        } else {
          assetMap.set(source.key, null)
        }
      } catch {
        assetMap.set(source.key, null)
      } finally {
        host.removeChild(wrapper)
      }
    }
  } finally {
    document.body.removeChild(host)
  }

  return assetMap
}

function wrapTextWithFirstLineWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  firstLineMaxWidth: number,
  otherLineMaxWidth: number,
): string[] {
  const paragraphs = text.split('\n')
  const lines: string[] = []
  let firstDisplayLine = true

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.replace(/\s+$/g, '')
    if (trimmed.length === 0) {
      lines.push('')
      firstDisplayLine = false
      continue
    }

    let current = ''
    for (const char of trimmed) {
      const maxWidth = firstDisplayLine ? firstLineMaxWidth : otherLineMaxWidth
      const candidate = `${current}${char}`
      const width = ctx.measureText(candidate).width
      if (width <= maxWidth || current.length === 0) {
        current = candidate
      } else {
        if (NO_LINE_START_CHARS.includes(char)) {
          current = candidate
          continue
        }

        const lastChar = current[current.length - 1] ?? ''
        if (NO_LINE_END_CHARS.includes(lastChar) && current.length > 1) {
          const carry = lastChar
          const pushLine = current.slice(0, -1)
          lines.push(pushLine)
          current = `${carry}${char}`
        } else {
          lines.push(current)
          current = char
        }
        firstDisplayLine = false
      }
    }

    if (current.length > 0) {
      lines.push(current)
      firstDisplayLine = false
    }
  }

  return lines.length > 0 ? lines : ['']
}

function getMathTokenSize(
  asset: MathAsset | null | undefined,
  latex: string,
  ctx: CanvasRenderingContext2D,
  fontSize: number,
  maxWidth: number,
  displayMode: boolean,
): { width: number; height: number } {
  const baseLineHeight = fontSize * LINE_HEIGHT_RATIO

  if (!asset) {
    const fallbackText = displayMode ? ` ${latex} ` : latex
    return {
      width: Math.min(maxWidth, ctx.measureText(fallbackText).width),
      height: baseLineHeight,
    }
  }

  const targetFontSize = fontSize
  const rawScale = targetFontSize / Math.max(1, asset.baseFontSize)
  const rawWidth = asset.width * rawScale
  const rawHeight = asset.height * rawScale
  const fitScale = rawWidth > maxWidth ? maxWidth / rawWidth : 1

  let width = rawWidth * fitScale
  let height = rawHeight * fitScale

  if (displayMode) {
    width *= DISPLAY_MATH_COMPACT_RATIO
    height *= DISPLAY_MATH_COMPACT_RATIO
  } else {
    const maxInlineHeight = baseLineHeight * INLINE_MATH_MAX_HEIGHT_RATIO
    if (height > maxInlineHeight) {
      const ratio = maxInlineHeight / height
      width *= ratio
      height = maxInlineHeight
    }
  }

  return {
    width,
    height,
  }
}

function compactLineBreakTokens(tokens: RenderInlineNode[]): RenderInlineNode[] {
  const result: RenderInlineNode[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.type !== 'lineBreak') {
      result.push(token)
      continue
    }

    const prev = result[result.length - 1]
    const next = tokens[i + 1]
    if (!prev || !next) {
      continue
    }
    if (prev.type === 'lineBreak' || next.type === 'lineBreak') {
      continue
    }
    if (prev.type === 'math' && prev.displayMode) {
      continue
    }
    if (next.type === 'math' && next.displayMode) {
      continue
    }

    result.push(token)
  }

  return result
}

function segmentsFromPlainText(
  text: string,
  style: {
    bold?: boolean
    fontFamily?: string
    color?: string
  } = {},
): RichTextSegment[] {
  const normalized = normalizeMathDelimiters(text)
  const segments: RichTextSegment[] = []
  const mathRegex = /(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g
  let cursor = 0

  for (const match of normalized.matchAll(mathRegex)) {
    const index = match.index ?? 0
    if (index > cursor) {
      pushTextSegment(segments, normalized.slice(cursor, index), style)
    }

    const token = match[0]
    if (token.startsWith('$$')) {
      const latex = token.slice(2, -2).trim()
      if (latex.length > 0) {
        segments.push({
          type: 'math',
          latex,
          displayMode: true,
        })
      }
    } else {
      const latex = token.slice(1, -1).trim()
      if (latex.length > 0) {
        segments.push({
          type: 'math',
          latex,
          displayMode: false,
        })
      }
    }

    cursor = index + token.length
  }

  if (cursor < normalized.length) {
    pushTextSegment(segments, normalized.slice(cursor), style)
  }

  return compactRichTextSegments(segments)
}

function tokenizeRichTextSegments(args: {
  segments: RichTextSegment[]
  ctx: CanvasRenderingContext2D
  fontSize: number
  maxWidth: number
  bold?: boolean
  fontFamily?: string
  color?: string
  mathAssetMap: Map<string, MathAsset | null>
}): RenderInlineNode[] {
  const { segments, ctx, fontSize, maxWidth, bold, fontFamily, color, mathAssetMap } = args
  const tokens: RenderInlineNode[] = []

  for (const segment of segments) {
    if (segment.type === 'lineBreak') {
      tokens.push({ type: 'lineBreak' })
      continue
    }

    if (segment.type === 'math') {
      const key = getMathKey(segment.latex, segment.displayMode)
      const asset = mathAssetMap.get(key) ?? null
      const size = getMathTokenSize(asset, segment.latex, ctx, fontSize, maxWidth, segment.displayMode)
      tokens.push({
        type: 'math',
        key,
        displayMode: segment.displayMode,
        width: size.width,
        height: size.height,
        latex: segment.latex,
      })
      continue
    }

    const resolvedFontWeight = segment.bold || bold ? 700 : 400
    const resolvedFontFamily = segment.fontFamily ?? fontFamily ?? QUESTION_FONT_FAMILY
    const resolvedColor = segment.color ?? color ?? '#1e2430'
    ctx.font = `${resolvedFontWeight} ${fontSize}px ${resolvedFontFamily}`

    const parts = segment.text.split('\n')
    parts.forEach((part, index) => {
      if (part.length > 0) {
        for (const char of part) {
          tokens.push({
            type: 'text',
            text: char,
            width: ctx.measureText(char).width,
            height: fontSize * LINE_HEIGHT_RATIO,
            fontWeight: resolvedFontWeight,
            fontFamily: resolvedFontFamily,
            color: resolvedColor,
          })
        }
      }
      if (index < parts.length - 1) {
        tokens.push({ type: 'lineBreak' })
      }
    })
  }

  return compactLineBreakTokens(tokens)
}

function tokenizeRichText(
  text: string,
  ctx: CanvasRenderingContext2D,
  fontSize: number,
  maxWidth: number,
  bold: boolean | undefined,
  fontFamily: string | undefined,
  color: string | undefined,
  mathAssetMap: Map<string, MathAsset | null>,
): RenderInlineNode[] {
  return tokenizeRichTextSegments({
    segments: segmentsFromPlainText(text, { bold, fontFamily, color }),
    ctx,
    fontSize,
    maxWidth,
    bold,
    fontFamily,
    color,
    mathAssetMap,
  })
}

function layoutRichTextLines(args: {
  text: string
  ctx: CanvasRenderingContext2D
  fontSize: number
  maxWidth: number
  bold?: boolean
  fontFamily?: string
  color?: string
  mathAssetMap: Map<string, MathAsset | null>
}): RichTextLine[] {
  const { text, ctx, fontSize, maxWidth, bold, fontFamily, color, mathAssetMap } = args
  const tokens = tokenizeRichText(text, ctx, fontSize, maxWidth, bold, fontFamily, color, mathAssetMap)
  return layoutTokenLines(tokens, fontSize, maxWidth)
}

function layoutRichTextSegmentLines(args: {
  segments: RichTextSegment[]
  ctx: CanvasRenderingContext2D
  fontSize: number
  maxWidth: number
  bold?: boolean
  fontFamily?: string
  color?: string
  mathAssetMap: Map<string, MathAsset | null>
}): RichTextLine[] {
  const { segments, ctx, fontSize, maxWidth, bold, fontFamily, color, mathAssetMap } = args
  const tokens = tokenizeRichTextSegments({
    segments,
    ctx,
    fontSize,
    maxWidth,
    bold,
    fontFamily,
    color,
    mathAssetMap,
  })
  return layoutTokenLines(tokens, fontSize, maxWidth)
}

function layoutTokenLines(
  tokens: RenderInlineNode[],
  fontSize: number,
  maxWidth: number,
): RichTextLine[] {
  const lines: RichTextLine[] = []
  const defaultHeight = fontSize * LINE_HEIGHT_RATIO
  let currentTokens: RenderInlineToken[] = []
  let currentWidth = 0
  let currentHeight = defaultHeight

  const pushCurrentLine = (forceEmpty = false) => {
    if (currentTokens.length > 0 || forceEmpty) {
      lines.push({
        tokens: [...currentTokens],
        width: currentWidth,
        height: currentHeight,
      })
    }
    currentTokens = []
    currentWidth = 0
    currentHeight = defaultHeight
  }

  for (const token of tokens) {
    if (token.type === 'lineBreak') {
      pushCurrentLine(true)
      continue
    }

    if (token.type === 'math' && token.displayMode) {
      if (currentTokens.length > 0) {
        pushCurrentLine(false)
      }
      lines.push({
        tokens: [token],
        width: token.width,
        height: Math.max(defaultHeight, token.height),
      })
      continue
    }

    if (currentWidth + token.width > maxWidth && currentTokens.length > 0) {
      const tokenIsNoLineStartText =
        token.type === 'text' &&
        token.text.length === 1 &&
        NO_LINE_START_CHARS.includes(token.text)

      if (!tokenIsNoLineStartText) {
        const lastToken = currentTokens[currentTokens.length - 1]
        const canCarryTail =
          lastToken &&
          lastToken.type === 'text' &&
          lastToken.text.length === 1 &&
          NO_LINE_END_CHARS.includes(lastToken.text) &&
          currentTokens.length > 1

        if (canCarryTail && lastToken.type === 'text') {
          currentTokens.pop()
          currentWidth -= lastToken.width
          currentHeight = Math.max(
            defaultHeight,
            ...currentTokens.map((item) => item.height),
          )
          pushCurrentLine(false)
          currentTokens.push(lastToken)
          currentWidth = lastToken.width
          currentHeight = Math.max(defaultHeight, lastToken.height)
        } else {
          pushCurrentLine(false)
        }
      }
    }

    currentTokens.push(token)
    currentWidth += token.width
    currentHeight = Math.max(currentHeight, token.height)
  }

  if (currentTokens.length > 0 || lines.length === 0) {
    pushCurrentLine(false)
  }

  return lines
}

function layoutRichTextLinesWithFirstLineOffset(args: {
  text?: string
  segments?: RichTextSegment[]
  ctx: CanvasRenderingContext2D
  fontSize: number
  maxWidth: number
  firstLineOffset: number
  bold?: boolean
  fontFamily?: string
  color?: string
  mathAssetMap: Map<string, MathAsset | null>
}): RichTextLine[] {
  const { text, segments, ctx, fontSize, maxWidth, firstLineOffset, bold, fontFamily, color, mathAssetMap } = args
  const tokens =
    segments
      ? tokenizeRichTextSegments({
          segments,
          ctx,
          fontSize,
          maxWidth,
          bold,
          fontFamily,
          color,
          mathAssetMap,
        })
      : tokenizeRichText(text ?? '', ctx, fontSize, maxWidth, bold, fontFamily, color, mathAssetMap)
  const lines: RichTextLine[] = []
  const defaultHeight = fontSize * LINE_HEIGHT_RATIO
  let currentTokens: RenderInlineToken[] = []
  let currentWidth = 0
  let currentHeight = defaultHeight
  let isFirstLine = true

  const currentMaxWidth = () =>
    Math.max(10, maxWidth - (isFirstLine ? Math.max(0, firstLineOffset) : 0))

  const pushCurrentLine = (forceEmpty = false) => {
    if (currentTokens.length > 0 || forceEmpty) {
      lines.push({
        tokens: [...currentTokens],
        width: currentWidth,
        height: currentHeight,
      })
    }
    currentTokens = []
    currentWidth = 0
    currentHeight = defaultHeight
    isFirstLine = false
  }

  for (const token of tokens) {
    if (token.type === 'lineBreak') {
      pushCurrentLine(true)
      continue
    }

    if (token.type === 'math' && token.displayMode) {
      if (currentTokens.length > 0) {
        pushCurrentLine(false)
      }
      lines.push({
        tokens: [token],
        width: token.width,
        height: Math.max(defaultHeight, token.height),
      })
      isFirstLine = false
      continue
    }

    if (currentWidth + token.width > currentMaxWidth() && currentTokens.length > 0) {
      const tokenIsNoLineStartText =
        token.type === 'text' &&
        token.text.length === 1 &&
        NO_LINE_START_CHARS.includes(token.text)

      if (!tokenIsNoLineStartText) {
        const lastToken = currentTokens[currentTokens.length - 1]
        const canCarryTail =
          lastToken &&
          lastToken.type === 'text' &&
          lastToken.text.length === 1 &&
          NO_LINE_END_CHARS.includes(lastToken.text) &&
          currentTokens.length > 1

        if (canCarryTail && lastToken.type === 'text') {
          currentTokens.pop()
          currentWidth -= lastToken.width
          currentHeight = Math.max(defaultHeight, ...currentTokens.map((item) => item.height))
          pushCurrentLine(false)
          currentTokens.push(lastToken)
          currentWidth = lastToken.width
          currentHeight = Math.max(defaultHeight, lastToken.height)
        } else {
          pushCurrentLine(false)
        }
      }
    }

    currentTokens.push(token)
    currentWidth += token.width
    currentHeight = Math.max(currentHeight, token.height)
  }

  if (currentTokens.length > 0 || lines.length === 0) {
    pushCurrentLine(false)
  }

  return lines
}

function resolveChoiceStemNodeLayout(args: {
  ctx: CanvasRenderingContext2D
  node: Extract<RenderNode, { type: 'choiceStem' }>
  widthPx: number
  mathAssetMap: Map<string, MathAsset | null>
}): {
  lines: RichTextLine[]
  fontWeight: number
  fontFamily: string
  color: string
  leadText: string
  leadGapPx: number
  leadFontSize: number
  leadFontWeight: number
  leadingWidth: number
  trailingBlankWidth: number
  trailingBlankFitsOnLastLine: boolean
  trailingBlankLineHeight: number
  totalHeight: number
} {
  const { ctx, node, widthPx, mathAssetMap } = args
  const fontWeight = node.bold ? 700 : 400
  const fontFamily = node.fontFamily ?? QUESTION_FONT_FAMILY
  const color = node.color ?? '#1e2430'
  const leadText = node.leadText ?? ''
  const leadGapPx = leadText.length > 0 ? node.leadGapPx ?? 0 : 0
  const leadFontScale = node.leadFontScale ?? 1
  const leadFontSize = node.fontSize * leadFontScale
  const leadFontWeight = node.leadBold || leadFontScale > 1 ? Math.max(700, fontWeight) : fontWeight

  let leadingWidth = 0
  if (leadText.length > 0) {
    ctx.font = `${leadFontWeight} ${leadFontSize}px ${fontFamily}`
    leadingWidth = ctx.measureText(leadText).width + leadGapPx
  }

  const lines = layoutRichTextLinesWithFirstLineOffset({
    text: node.text,
    ctx,
    fontSize: node.fontSize,
    maxWidth: widthPx,
    firstLineOffset: leadingWidth,
    mathAssetMap,
  })

  const leadLineHeight = leadText.length > 0 ? leadFontSize * LINE_HEIGHT_RATIO : 0
  if (lines.length > 0 && leadLineHeight > lines[0].height) {
    lines[0] = {
      ...lines[0],
      height: leadLineHeight,
    }
  }

  ctx.font = `${fontWeight} ${node.fontSize}px ${fontFamily}`
  const trailingBlankWidth = ctx.measureText(node.trailingBlank).width
  const trailingBlankLineHeight = node.fontSize * LINE_HEIGHT_RATIO
  const lastLine = lines[lines.length - 1]
  const lastLineAvailableWidth = lines.length === 1 ? Math.max(10, widthPx - leadingWidth) : widthPx
  const trailingBlankFitsOnLastLine =
    !!lastLine && lastLine.width + trailingBlankWidth <= lastLineAvailableWidth
  const totalHeight =
    measureRichTextLinesHeight(lines) + (trailingBlankFitsOnLastLine ? 0 : trailingBlankLineHeight)

  return {
    lines,
    fontWeight,
    fontFamily,
    color,
    leadText,
    leadGapPx,
    leadFontSize,
    leadFontWeight,
    leadingWidth,
    trailingBlankWidth,
    trailingBlankFitsOnLastLine,
    trailingBlankLineHeight,
    totalHeight,
  }
}

function measureRichTextLinesHeight(lines: RichTextLine[]): number {
  return lines.reduce((sum, line) => sum + line.height, 0)
}

interface TableLayoutCell {
  lines: RichTextLine[]
}

interface TableLayoutRow {
  cells: TableLayoutCell[]
  height: number
}

interface TableLayout {
  columnWidths: number[]
  rows: TableLayoutRow[]
  totalHeight: number
}

function resolveTableNodeLayout(args: {
  ctx: CanvasRenderingContext2D
  node: Extract<RenderNode, { type: 'table' }>
  widthPx: number
  mathAssetMap: Map<string, MathAsset | null>
}): TableLayout {
  const { ctx, node, widthPx, mathAssetMap } = args
  const columnCount = Math.max(1, ...node.rows.map((row) => row.cells.length))
  const equalWidth = Math.max(TABLE_MIN_COLUMN_WIDTH_PX, widthPx / columnCount)
  const scaledWidth =
    equalWidth * columnCount > widthPx ? widthPx / columnCount : equalWidth
  const columnWidths = Array.from({ length: columnCount }, () => scaledWidth)

  const rows = node.rows.map((row) => {
    const cells = row.cells.map((cellSegments) => {
      const innerWidth = Math.max(10, scaledWidth - TABLE_CELL_HORIZONTAL_PADDING_PX * 2)
      return {
        lines: layoutRichTextSegmentLines({
          segments: cellSegments,
          ctx,
          fontSize: node.fontSize,
          maxWidth: innerWidth,
          bold: node.bold,
          fontFamily: node.fontFamily,
          color: node.color,
          mathAssetMap,
        }),
      }
    })

    const height =
      Math.max(
        node.fontSize * LINE_HEIGHT_RATIO,
        ...cells.map((cell) => measureRichTextLinesHeight(cell.lines)),
      ) +
      TABLE_CELL_VERTICAL_PADDING_PX * 2

    return {
      cells,
      height,
    }
  })

  return {
    columnWidths,
    rows,
    totalHeight: rows.reduce((sum, row) => sum + row.height, 0),
  }
}

function drawRichTextLines(args: {
  ctx: CanvasRenderingContext2D
  lines: RichTextLine[]
  x: number
  y: number
  maxWidth: number
  fontSize: number
  fontWeight: number
  fontFamily: string
  color: string
  mathAssetMap: Map<string, MathAsset | null>
  draw: boolean
}): number {
  const {
    ctx,
    lines,
    x,
    y: startY,
    maxWidth,
    fontSize,
    fontWeight,
    fontFamily,
    color,
    mathAssetMap,
    draw,
  } = args
  let y = startY

  if (!draw) {
    return y + measureRichTextLinesHeight(lines)
  }

  const previousBaseline = ctx.textBaseline
  ctx.textBaseline = 'top'

  for (const line of lines) {
    let cursorX = x
    const shouldCenterDisplayLine =
      line.tokens.length === 1 &&
      line.tokens[0].type === 'math' &&
      line.tokens[0].displayMode === true

    if (shouldCenterDisplayLine) {
      cursorX = x + Math.max(0, (maxWidth - line.width) / 2)
    }

    let textRun = ''
    let runFontWeight = fontWeight
    let runFontFamily = fontFamily
    let runColor = color

    const flushTextRun = () => {
      if (textRun.length === 0) {
        return
      }
      ctx.font = `${runFontWeight} ${fontSize}px ${runFontFamily}`
      ctx.fillStyle = runColor
      const textTopOffset = (line.height - fontSize * LINE_HEIGHT_RATIO) / 2
      ctx.fillText(textRun, cursorX, y + textTopOffset)
      cursorX += ctx.measureText(textRun).width
      textRun = ''
    }

    for (const token of line.tokens) {
      if (token.type === 'text') {
        if (
          textRun.length > 0 &&
          (token.fontWeight !== runFontWeight ||
            token.fontFamily !== runFontFamily ||
            token.color !== runColor)
        ) {
          flushTextRun()
        }

        if (textRun.length === 0) {
          runFontWeight = token.fontWeight
          runFontFamily = token.fontFamily
          runColor = token.color
        }

        textRun += token.text
        continue
      }

      flushTextRun()
      const asset = mathAssetMap.get(token.key) ?? null
      const isQuestionFont = fontFamily === QUESTION_FONT_FAMILY
      const inlineShiftEm =
        INLINE_MATH_ASCENT_SHIFT_EM + (isQuestionFont ? QUESTION_INLINE_MATH_EXTRA_SHIFT_EM : 0)
      const verticalShift = token.displayMode ? 0 : -fontSize * inlineShiftEm
      const drawTop = y + (line.height - token.height) / 2 + verticalShift
      if (asset) {
        ctx.drawImage(asset.canvas, cursorX, drawTop, token.width, token.height)
      } else {
        const fallback = token.displayMode ? ` ${token.latex} ` : token.latex
        const textTopOffset = (line.height - fontSize * LINE_HEIGHT_RATIO) / 2 + verticalShift
        ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`
        ctx.fillStyle = color
        ctx.fillText(fallback, cursorX, y + textTopOffset)
      }
      cursorX += token.width
    }
    flushTextRun()
    y += line.height
  }

  ctx.textBaseline = previousBaseline
  return y
}

function drawTableNode(args: {
  ctx: CanvasRenderingContext2D
  node: Extract<RenderNode, { type: 'table' }>
  x: number
  y: number
  widthPx: number
  mathAssetMap: Map<string, MathAsset | null>
  draw: boolean
}): number {
  const { ctx, node, x, y: startY, widthPx, mathAssetMap, draw } = args
  const layout = resolveTableNodeLayout({
    ctx,
    node,
    widthPx,
    mathAssetMap,
  })

  if (!draw) {
    return startY + layout.totalHeight
  }

  let rowY = startY
  layout.rows.forEach((row, rowIndex) => {
    let cellX = x
    layout.columnWidths.forEach((columnWidth, columnIndex) => {
      if (rowIndex < node.headerRowCount) {
        ctx.fillStyle = TABLE_HEADER_FILL_COLOR
        ctx.fillRect(cellX, rowY, columnWidth, row.height)
      }

      ctx.strokeStyle = TABLE_BORDER_COLOR
      ctx.lineWidth = 1
      ctx.strokeRect(cellX, rowY, columnWidth, row.height)

      const cell = row.cells[columnIndex]
      if (cell) {
        drawRichTextLines({
          ctx,
          lines: cell.lines,
          x: cellX + TABLE_CELL_HORIZONTAL_PADDING_PX,
          y: rowY + TABLE_CELL_VERTICAL_PADDING_PX,
          maxWidth: Math.max(10, columnWidth - TABLE_CELL_HORIZONTAL_PADDING_PX * 2),
          fontSize: node.fontSize,
          fontWeight: node.bold ? 700 : 400,
          fontFamily: node.fontFamily ?? QUESTION_FONT_FAMILY,
          color: node.color ?? '#1e2430',
          mathAssetMap,
          draw: true,
        })
      }

      cellX += columnWidth
    })

    rowY += row.height
  })

  return rowY
}

function splitRichTextLinesByHeight(lines: RichTextLine[], maxHeight: number): {
  head: RichTextLine[]
  tail: RichTextLine[]
} | null {
  if (lines.length <= 1 || maxHeight <= 0) {
    return null
  }

  let consumed = 0
  let index = 0
  while (index < lines.length && consumed + lines[index].height <= maxHeight) {
    consumed += lines[index].height
    index += 1
  }

  if (index <= 0 || index >= lines.length) {
    return null
  }

  return {
    head: lines.slice(0, index),
    tail: lines.slice(index),
  }
}

function splitTableNodeByHeight(
  node: Extract<RenderNode, { type: 'table' }>,
  ctx: CanvasRenderingContext2D,
  widthPx: number,
  maxHeight: number,
  mathAssetMap: Map<string, MathAsset | null>,
): { head: Extract<RenderNode, { type: 'table' }>; tail: Extract<RenderNode, { type: 'table' }> } | null {
  const layout = resolveTableNodeLayout({
    ctx,
    node,
    widthPx,
    mathAssetMap,
  })

  if (layout.rows.length <= node.headerRowCount + 1 || maxHeight <= 0) {
    return null
  }

  let consumed = 0
  let splitIndex = 0
  while (splitIndex < layout.rows.length && consumed + layout.rows[splitIndex].height <= maxHeight) {
    consumed += layout.rows[splitIndex].height
    splitIndex += 1
  }

  if (splitIndex <= node.headerRowCount || splitIndex >= layout.rows.length) {
    return null
  }

  const headerRows = node.rows.slice(0, node.headerRowCount)

  return {
    head: {
      ...node,
      rows: node.rows.slice(0, splitIndex),
    },
    tail: {
      ...node,
      rows: [...headerRows, ...node.rows.slice(splitIndex)],
    },
  }
}

function resolveImageDrawSize(
  image: HTMLImageElement | null,
  maxWidthPx: number,
): {
  widthPx: number
  heightPx: number
  canDraw: boolean
} {
  if (!image || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return {
      widthPx: maxWidthPx,
      heightPx: IMAGE_PLACEHOLDER_HEIGHT_PX,
      canDraw: false,
    }
  }

  const ratio = image.naturalWidth / image.naturalHeight
  let widthPx = maxWidthPx
  let heightPx = widthPx / Math.max(0.1, ratio)

  if (heightPx > IMAGE_MAX_HEIGHT_PX) {
    heightPx = IMAGE_MAX_HEIGHT_PX
    widthPx = Math.min(maxWidthPx, heightPx * ratio)
  }

  if (heightPx < IMAGE_MIN_HEIGHT_PX) {
    heightPx = IMAGE_MIN_HEIGHT_PX
    widthPx = Math.min(maxWidthPx, heightPx * ratio)
  }

  return {
    widthPx,
    heightPx,
    canDraw: true,
  }
}

function resolveImageRowLayout(args: {
  images: Array<{ src: string; alt: string }>
  maxWidthPx: number
  imageMap: Map<string, HTMLImageElement | null>
}): {
  items: Array<{
    src: string
    alt: string
    xOffset: number
    widthPx: number
    heightPx: number
    canDraw: boolean
  }>
  rowHeightPx: number
} {
  const { images, maxWidthPx, imageMap } = args
  if (images.length === 0) {
    return { items: [], rowHeightPx: 0 }
  }

  if (images.length === 1) {
    const only = images[0]
    const size = resolveImageDrawSize(imageMap.get(only.src) ?? null, maxWidthPx)
    return {
      items: [
        {
          src: only.src,
          alt: only.alt,
          xOffset: 0,
          widthPx: size.widthPx,
          heightPx: size.heightPx,
          canDraw: size.canDraw,
        },
      ],
      rowHeightPx: size.heightPx,
    }
  }

  const gapTotal = (images.length - 1) * IMAGE_ROW_GAP_PX
  const availableWidth = Math.max(1, maxWidthPx - gapTotal)
  const ratios = images.map((item) => getImageRatio(imageMap.get(item.src) ?? null))
  const ratioSum = ratios.reduce((sum, value) => sum + value, 0)
  const rowHeightPx = availableWidth / Math.max(0.1, ratioSum)

  let cursorX = 0
  const items = images.map((item, index) => {
    const widthPx = ratios[index] * rowHeightPx
    const canDraw = (imageMap.get(item.src)?.naturalWidth ?? 0) > 0
    const result = {
      src: item.src,
      alt: item.alt,
      xOffset: cursorX,
      widthPx,
      heightPx: rowHeightPx,
      canDraw,
    }
    cursorX += widthPx + IMAGE_ROW_GAP_PX
    return result
  })

  return {
    items,
    rowHeightPx,
  }
}

function layoutAndDrawNodes(args: {
  ctx: CanvasRenderingContext2D
  nodes: RenderNode[]
  x: number
  y: number
  widthPx: number
  imageMap: Map<string, HTMLImageElement | null>
  mathAssetMap: Map<string, MathAsset | null>
  draw: boolean
}): number {
  const { ctx, nodes, x, y: startY, widthPx, imageMap, mathAssetMap, draw } = args
  let y = startY

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]

    if (node.type === 'space') {
      y += mmToPx(node.heightMm)
      continue
    }

    if (node.type === 'text') {
      const fontWeight = node.bold ? 700 : 400
      const fontFamily = node.fontFamily ?? QUESTION_FONT_FAMILY
      const color = node.color ?? '#1e2430'
      ctx.font = `${fontWeight} ${node.fontSize}px ${fontFamily}`
      ctx.fillStyle = color
      const lines = layoutRichTextLines({
        text: node.text,
        ctx,
        fontSize: node.fontSize,
        maxWidth: widthPx,
        bold: node.bold,
        fontFamily,
        color,
        mathAssetMap,
      })
      y = drawRichTextLines({
        ctx,
        lines,
        x,
        y,
        maxWidth: widthPx,
        fontSize: node.fontSize,
        fontWeight,
        fontFamily,
        color,
        mathAssetMap,
        draw,
      })
    }

    if (node.type === 'richText') {
      const fontWeight = node.bold ? 700 : 400
      const fontFamily = node.fontFamily ?? QUESTION_FONT_FAMILY
      const color = node.color ?? '#1e2430'
      const lines = layoutRichTextSegmentLines({
        segments: node.segments,
        ctx,
        fontSize: node.fontSize,
        maxWidth: widthPx,
        bold: node.bold,
        fontFamily,
        color,
        mathAssetMap,
      })
      y = drawRichTextLines({
        ctx,
        lines,
        x,
        y,
        maxWidth: widthPx,
        fontSize: node.fontSize,
        fontWeight,
        fontFamily,
        color,
        mathAssetMap,
        draw,
      })
    }

    if (node.type === 'richTextLines') {
      const fontWeight = node.bold ? 700 : 400
      const fontFamily = node.fontFamily ?? QUESTION_FONT_FAMILY
      const color = node.color ?? '#1e2430'
      y = drawRichTextLines({
        ctx,
        lines: node.lines,
        x,
        y,
        maxWidth: widthPx,
        fontSize: node.fontSize,
        fontWeight,
        fontFamily,
        color,
        mathAssetMap,
        draw,
      })
    }

    if (node.type === 'markedText') {
      const fontWeight = node.bold ? 700 : 400
      const baseFontSize = node.fontSize
      const markerScale = node.markerScale ?? QUESTION_MARKER_SCALE
      const markerFontSize = baseFontSize * markerScale
      const lineHeight = baseFontSize * LINE_HEIGHT_RATIO
      const firstLineHeight = Math.max(lineHeight, markerFontSize * LINE_HEIGHT_RATIO)
      const fontFamily = node.fontFamily ?? QUESTION_FONT_FAMILY
      const fillColor = node.color ?? '#1e2430'

      ctx.font = `${fontWeight} ${baseFontSize}px ${fontFamily}`
      ctx.fillStyle = fillColor
      const markerWeight = Math.max(700, fontWeight)
      ctx.font = `${markerWeight} ${markerFontSize}px ${fontFamily}`
      const markerWidth = ctx.measureText(node.marker).width + QUESTION_MARKER_GAP_PX

      ctx.font = `${fontWeight} ${baseFontSize}px ${fontFamily}`
      const lines = wrapTextWithFirstLineWidth(
        ctx,
        node.text,
        Math.max(10, widthPx - markerWidth),
        widthPx,
      )

      if (draw) {
        y += firstLineHeight
        ctx.font = `${markerWeight} ${markerFontSize}px ${fontFamily}`
        ctx.fillStyle = fillColor
        ctx.fillText(node.marker, x, y)

        ctx.font = `${fontWeight} ${baseFontSize}px ${fontFamily}`
        ctx.fillStyle = fillColor
        const firstLine = lines[0] ?? ''
        if (firstLine.length > 0) {
          ctx.fillText(firstLine, x + markerWidth, y)
        }

        for (const line of lines.slice(1)) {
          y += lineHeight
          ctx.fillText(line, x, y)
        }
      } else {
        y += firstLineHeight
        y += Math.max(0, lines.length - 1) * lineHeight
      }
    }

    if (node.type === 'choiceStem') {
      const layout = resolveChoiceStemNodeLayout({
        ctx,
        node,
        widthPx,
        mathAssetMap,
      })

      if (draw) {
        const previousBaseline = ctx.textBaseline
        ctx.textBaseline = 'top'
        ctx.fillStyle = layout.color

        let lineY = y
        layout.lines.forEach((line, index) => {
          const lineX = x + (index === 0 ? layout.leadingWidth : 0)
          const availableWidth = index === 0 ? Math.max(10, widthPx - layout.leadingWidth) : widthPx

          if (index === 0 && layout.leadText.length > 0) {
            ctx.font = `${layout.leadFontWeight} ${layout.leadFontSize}px ${layout.fontFamily}`
            const leadTopOffset = (line.height - layout.leadFontSize * LINE_HEIGHT_RATIO) / 2
            ctx.fillText(layout.leadText, x, lineY + leadTopOffset)
          }

          ctx.font = `${layout.fontWeight} ${node.fontSize}px ${layout.fontFamily}`
          let cursorX = lineX
          const shouldCenterDisplayLine =
            line.tokens.length === 1 &&
            line.tokens[0].type === 'math' &&
            line.tokens[0].displayMode === true

          if (shouldCenterDisplayLine) {
            cursorX = lineX + Math.max(0, (availableWidth - line.width) / 2)
          }

          for (const token of line.tokens) {
            if (token.type === 'text') {
              const textTopOffset = (line.height - token.height) / 2
              ctx.fillText(token.text, cursorX, lineY + textTopOffset)
              cursorX += token.width
              continue
            }

            const asset = mathAssetMap.get(token.key) ?? null
            const isQuestionFont = layout.fontFamily === QUESTION_FONT_FAMILY
            const inlineShiftEm =
              INLINE_MATH_ASCENT_SHIFT_EM +
              (isQuestionFont ? QUESTION_INLINE_MATH_EXTRA_SHIFT_EM : 0)
            const verticalShift = token.displayMode ? 0 : -node.fontSize * inlineShiftEm
            const drawTop = lineY + (line.height - token.height) / 2 + verticalShift
            if (asset) {
              ctx.drawImage(asset.canvas, cursorX, drawTop, token.width, token.height)
            } else {
              const fallback = token.displayMode ? ` ${token.latex} ` : token.latex
              const textTopOffset =
                (line.height - node.fontSize * LINE_HEIGHT_RATIO) / 2 + verticalShift
              ctx.fillText(fallback, cursorX, lineY + textTopOffset)
            }
            cursorX += token.width
          }

          if (index === layout.lines.length - 1 && layout.trailingBlankFitsOnLastLine) {
            const blankTopOffset = (line.height - layout.trailingBlankLineHeight) / 2
            ctx.fillText(
              node.trailingBlank,
              x + widthPx - layout.trailingBlankWidth,
              lineY + blankTopOffset,
            )
          }

          lineY += line.height
        })

        if (!layout.trailingBlankFitsOnLastLine) {
          ctx.font = `${layout.fontWeight} ${node.fontSize}px ${layout.fontFamily}`
          ctx.fillText(node.trailingBlank, x + widthPx - layout.trailingBlankWidth, lineY)
          lineY += layout.trailingBlankLineHeight
        }

        ctx.textBaseline = previousBaseline
        y = lineY
      } else {
        y += layout.totalHeight
      }
    }

    if (node.type === 'table') {
      y = drawTableNode({
        ctx,
        node,
        x,
        y,
        widthPx,
        mathAssetMap,
        draw,
      })
    }

    if (node.type === 'image') {
      const image = imageMap.get(node.src) ?? null
      const size = resolveImageDrawSize(image, widthPx)

      if (draw) {
        if (size.canDraw && image) {
          ctx.drawImage(image, x, y, size.widthPx, size.heightPx)
        } else {
          ctx.strokeStyle = '#cfd5e2'
          ctx.setLineDash([4, 3])
          ctx.strokeRect(x, y, size.widthPx, size.heightPx)
          ctx.setLineDash([])
          ctx.font = `400 12px ${QUESTION_FONT_FAMILY}`
          ctx.fillStyle = '#788292'
          ctx.fillText(`${node.alt || '图片'}（加载失败）`, x + 8, y + 22)
        }
      }

      y += size.heightPx
    }

    if (node.type === 'imageRow') {
      const layout = resolveImageRowLayout({
        images: node.images,
        maxWidthPx: widthPx,
        imageMap,
      })

      if (draw) {
        for (const item of layout.items) {
          const image = imageMap.get(item.src) ?? null
          const drawX = x + item.xOffset
          if (item.canDraw && image) {
            ctx.drawImage(image, drawX, y, item.widthPx, item.heightPx)
          } else {
            ctx.strokeStyle = '#cfd5e2'
            ctx.setLineDash([4, 3])
            ctx.strokeRect(drawX, y, item.widthPx, item.heightPx)
            ctx.setLineDash([])
            ctx.font = `400 12px ${QUESTION_FONT_FAMILY}`
            ctx.fillStyle = '#788292'
            ctx.fillText(`${item.alt || '图片'}（加载失败）`, drawX + 8, y + 22)
          }
        }
      }

      y += layout.rowHeightPx
    }

    const next = nodes[i + 1]
    if (next && next.type !== 'space') {
      y += NODE_GAP_PX
    }
  }

  return y
}

function makeBlock(
  ctx: CanvasRenderingContext2D,
  nodes: RenderNode[],
  columnWidthPx: number,
  imageMap: Map<string, HTMLImageElement | null>,
  mathAssetMap: Map<string, MathAsset | null>,
): RenderBlock {
  const endY = layoutAndDrawNodes({
    ctx,
    nodes,
    x: 0,
    y: 0,
    widthPx: columnWidthPx,
    imageMap,
    mathAssetMap,
    draw: false,
  })

  return {
    nodes,
    heightPx: Math.ceil(endY),
  }
}

function buildAnalysisBlocks(
  analysisMarkdown: string,
  measureCtx: CanvasRenderingContext2D,
  columnWidthPx: number,
  imageMap: Map<string, HTMLImageElement | null>,
  mathAssetMap: Map<string, MathAsset | null>,
  spacingConfig: PdfExportSpacingConfig,
): RenderBlock[] {
  const normalized = analysisMarkdown.replace(/\r/g, '').trim()
  if (normalized.length === 0) {
    return []
  }

  const nodes: RenderNode[] = [
    {
      type: 'space',
      heightMm: spacingConfig.analysisTopGapMm,
    },
    ...buildAnalysisNodes(normalized),
  ]

  return [makeBlock(measureCtx, nodes, columnWidthPx, imageMap, mathAssetMap)]
}

function appendAnalysisSpacing(nodes: RenderNode[], spacingConfig: PdfExportSpacingConfig) {
  nodes.push({
    type: 'space',
    heightMm: spacingConfig.analysisTopGapMm,
  })
}

function formatChoiceStemMarkdownForExport(normalizedStem: string): string {
  const withoutTrailingBlank = normalizedStem.replace(/\s*\[\[INLINE_BLANK_\d+\]\]\s*$/u, '')
  if (withoutTrailingBlank !== normalizedStem) {
    return withoutTrailingBlank.trimEnd()
  }

  return normalizedStem.replace(INLINE_TOKEN_REGEX, CHOICE_BLANK_TEXT)
}

function appendChoiceContentNodes(args: {
  nodes: RenderNode[]
  normalizedStem: string
  optionCount: number
  options: string[]
  correctAnswers: number[]
  optionStyle: ChoiceSubQuestion['optionStyle']
  spacingConfig: PdfExportSpacingConfig
  questionMarker?: string
  questionLabel?: string
  includeTrailingSpace?: boolean
}) {
  const {
    nodes,
    normalizedStem,
    optionCount,
    options,
    correctAnswers,
    optionStyle,
    spacingConfig,
    questionMarker,
    questionLabel,
    includeTrailingSpace = true,
  } = args

  const stemMarkdown = formatChoiceStemMarkdownForExport(normalizedStem)
  const stemSplit = splitMarkdownTextAndImages(stemMarkdown)
  const rawStemNodes = stemSplit.textMarkdown.length > 0 ? markdownToNodes(stemSplit.textMarkdown) : []
  const stemNodes = questionLabel
    ? prependLabelToNodes(`${questionLabel} `, rawStemNodes, {
        bold: true,
        fontSize: BASE_FONT_SIZE,
        fontFamily: QUESTION_FONT_FAMILY,
        color: '#1e2430',
      })
    : questionMarker
      ? prependQuestionMarkerToNodes(questionMarker, rawStemNodes)
      : rawStemNodes

  nodes.push(...stemNodes)

  if (stemSplit.images.length > 0) {
    if (stemNodes.length > 0) {
      nodes.push({
        type: 'space',
        heightMm: spacingConfig.choiceStemImageTopGapMm,
      })
    }
    nodes.push(...buildChoiceLikeImageRows(stemSplit.images))
    nodes.push({
      type: 'space',
      heightMm: spacingConfig.choiceStemImageBottomGapMm,
    })
  } else {
    nodes.push({
      type: 'space',
      heightMm: spacingConfig.choiceStemGapMm,
    })
  }

  const visibleOptions = options.slice(0, optionCount)
  visibleOptions.forEach((option, index) => {
    const marker = buildOptionMarker(index, optionStyle)
    const isCorrect = correctAnswers.includes(index)
    const optionColor = isCorrect ? CORRECT_OPTION_COLOR : '#1e2430'
    const optionNodes = prependLabelToNodes(`${marker}. `, markdownToNodes(option, { color: optionColor }), {
      color: optionColor,
    })
    nodes.push(...optionNodes)
    if (index < visibleOptions.length - 1) {
      nodes.push({
        type: 'space',
        heightMm: spacingConfig.choiceOptionGapMm,
      })
    }
  })

  if (includeTrailingSpace) {
    nodes.push({
      type: 'space',
      heightMm: spacingConfig.choiceAfterOptionsGapMm,
    })
  }
}

function buildChoicePlan(
  question: Extract<Question, { type: 'choice' }>,
  measureCtx: CanvasRenderingContext2D,
  columnWidthPx: number,
  imageMap: Map<string, HTMLImageElement | null>,
  mathAssetMap: Map<string, MathAsset | null>,
  includeAnalysis: boolean,
  spacingConfig: PdfExportSpacingConfig,
): RenderPlan {
  const baseStem = migrateStemTokens(question.normalizedStem)
  const normalizedStem =
    countInlineTokens(baseStem) > 0 ? baseStem : `${baseStem.trimEnd()} [[INLINE_BLANK_1]]`.trim()
  const marker = buildQuestionMarker(question)
  const nodes: RenderNode[] = []
  appendChoiceContentNodes({
    nodes,
    normalizedStem,
    optionCount: question.optionCount,
    options: question.options,
    correctAnswers: question.correctAnswers,
    optionStyle: question.optionStyle,
    spacingConfig,
    questionMarker: marker,
  })

  const coreBlock = makeBlock(measureCtx, nodes, columnWidthPx, imageMap, mathAssetMap)
  const analysisBlocks =
    includeAnalysis && question.analysis.trim().length > 0
      ? buildAnalysisBlocks(
          question.analysis,
          measureCtx,
          columnWidthPx,
          imageMap,
          mathAssetMap,
          spacingConfig,
        )
      : []
  const blocks = [coreBlock, ...analysisBlocks]

  return {
    type: 'choiceGroup',
    blocks,
    totalHeightPx: blocks.reduce((sum, item) => sum + item.heightPx, 0),
  }
}

function buildBlankPlan(
  question: Extract<Question, { type: 'blank' }>,
  measureCtx: CanvasRenderingContext2D,
  columnWidthPx: number,
  imageMap: Map<string, HTMLImageElement | null>,
  mathAssetMap: Map<string, MathAsset | null>,
  includeAnalysis: boolean,
  spacingConfig: PdfExportSpacingConfig,
): RenderPlan {
  const baseStem = migrateStemTokens(question.normalizedStem)
  const normalizedStem =
    countInlineTokens(baseStem) > 0 ? baseStem : `${baseStem.trimEnd()} [[INLINE_BLANK_1]]`.trim()
  const blankCount = Math.max(1, question.blankCount)
  const extraSpaceMm =
    spacingConfig.blankBaseAnswerSpaceMm +
    Math.max(0, blankCount - 1) * spacingConfig.blankPerExtraAnswerSpaceMm
  const stemMarkdown = normalizedStem.replace(INLINE_TOKEN_REGEX, FILL_BLANK_TEXT)
  const stemSplit = splitMarkdownTextAndImages(stemMarkdown)
  const marker = buildQuestionMarker(question)
  const rawStemNodes = stemSplit.textMarkdown.length > 0 ? markdownToNodes(stemSplit.textMarkdown) : []
  const stemNodes = prependQuestionMarkerToNodes(marker, rawStemNodes)

  const nodes: RenderNode[] = [...stemNodes]

  if (stemSplit.images.length > 0) {
    if (stemNodes.length > 0) {
      nodes.push({
        type: 'space',
        heightMm: spacingConfig.blankStemImageTopGapMm,
      })
    }
    nodes.push(...buildChoiceLikeImageRows(stemSplit.images))
    nodes.push({
      type: 'space',
      heightMm: spacingConfig.blankStemImageBottomGapMm,
    })
  }

  nodes.push({
    type: 'space',
    heightMm: extraSpaceMm,
  })

  const coreBlock = makeBlock(measureCtx, nodes, columnWidthPx, imageMap, mathAssetMap)
  const analysisBlocks =
    includeAnalysis && question.analysis.trim().length > 0
      ? buildAnalysisBlocks(
          question.analysis,
          measureCtx,
          columnWidthPx,
          imageMap,
          mathAssetMap,
          spacingConfig,
        )
      : []
  const blocks = [coreBlock, ...analysisBlocks]

  return {
    type: 'blank',
    blocks,
    totalHeightPx: blocks.reduce((sum, item) => sum + item.heightPx, 0),
  }
}

function buildChoiceGroupAnalysisBlocks(
  question: Extract<Question, { type: 'choiceGroup' }>,
  measureCtx: CanvasRenderingContext2D,
  columnWidthPx: number,
  imageMap: Map<string, HTMLImageElement | null>,
  mathAssetMap: Map<string, MathAsset | null>,
  spacingConfig: PdfExportSpacingConfig,
): RenderBlock[] {
  const nodes: RenderNode[] = []

  question.subquestions.forEach((subquestion, index) => {
    const analysis = subquestion.analysis.trim()
    if (analysis.length === 0) {
      return
    }

    appendAnalysisSpacing(nodes, spacingConfig)
    nodes.push(
      ...prependLabelToNodes(`第${index + 1}题解析：`, buildAnalysisNodes(analysis), {
        bold: true,
        fontSize: ANALYSIS_FONT_SIZE,
        fontFamily: ANALYSIS_FONT_FAMILY,
        color: '#2f3a4c',
      }),
    )
  })

  if (nodes.length === 0) {
    return []
  }

  return [makeBlock(measureCtx, nodes, columnWidthPx, imageMap, mathAssetMap)]
}

function buildChoiceGroupPlan(
  question: Extract<Question, { type: 'choiceGroup' }>,
  measureCtx: CanvasRenderingContext2D,
  columnWidthPx: number,
  imageMap: Map<string, HTMLImageElement | null>,
  mathAssetMap: Map<string, MathAsset | null>,
  includeAnalysis: boolean,
  spacingConfig: PdfExportSpacingConfig,
): RenderPlan {
  const nodes: RenderNode[] = []
  const materialMarker = buildQuestionMarker(question)
  const materialSplit = splitMarkdownTextAndImages(question.normalizedStem || question.stem)
  const rawMaterialNodes =
    materialSplit.textMarkdown.length > 0 ? markdownToNodes(materialSplit.textMarkdown) : []
  const materialNodes = prependQuestionMarkerToNodes(materialMarker, rawMaterialNodes)

  nodes.push(...materialNodes)

  if (materialSplit.images.length > 0) {
    if (materialNodes.length > 0) {
      nodes.push({
        type: 'space',
        heightMm: spacingConfig.choiceStemImageTopGapMm,
      })
    }
    nodes.push(...buildChoiceLikeImageRows(materialSplit.images))
  }

  if (nodes.length > 0) {
    nodes.push({
      type: 'space',
      heightMm: spacingConfig.choiceGroupMaterialGapMm,
    })
  }

  question.subquestions.forEach((subquestion, index) => {
    const baseStem = migrateStemTokens(subquestion.normalizedStem)
    const normalizedStem =
      countInlineTokens(baseStem) > 0 ? baseStem : `${baseStem.trimEnd()} [[INLINE_BLANK_1]]`.trim()

    appendChoiceContentNodes({
      nodes,
      normalizedStem,
      optionCount: subquestion.optionCount,
      options: subquestion.options,
      correctAnswers: subquestion.correctAnswers,
      optionStyle: subquestion.optionStyle,
      spacingConfig,
      questionLabel: `${index + 1}.`,
      includeTrailingSpace: false,
    })

    if (index < question.subquestions.length - 1) {
      nodes.push({
        type: 'space',
        heightMm: spacingConfig.choiceGroupQuestionGapMm,
      })
    } else {
      nodes.push({
        type: 'space',
        heightMm: spacingConfig.choiceAfterOptionsGapMm,
      })
    }
  })

  const coreBlock = makeBlock(measureCtx, nodes, columnWidthPx, imageMap, mathAssetMap)
  const analysisBlocks = includeAnalysis
    ? buildChoiceGroupAnalysisBlocks(
        question,
        measureCtx,
        columnWidthPx,
        imageMap,
        mathAssetMap,
        spacingConfig,
      )
    : []
  const blocks = [coreBlock, ...analysisBlocks]

  return {
    type: 'choice',
    blocks,
    totalHeightPx: blocks.reduce((sum, item) => sum + item.heightPx, 0),
  }
}

function buildSubjectivePlan(
  question: Extract<Question, { type: 'subjective' }>,
  measureCtx: CanvasRenderingContext2D,
  columnWidthPx: number,
  imageMap: Map<string, HTMLImageElement | null>,
  mathAssetMap: Map<string, MathAsset | null>,
  includeAnalysis: boolean,
  spacingConfig: PdfExportSpacingConfig,
): RenderPlan {
  const baseStem = question.normalizedStem
  const areaCount = Math.max(1, Math.max(question.areaCount, countAreaTokens(baseStem)))
  const splitted = splitSubjectiveStem(baseStem, areaCount)
  const unitSpaceMm =
    question.subject === 'math'
      ? spacingConfig.subjectiveMathAnswerSpaceMm
      : spacingConfig.subjectiveAnswerSpaceMm
  const marker = buildQuestionMarker(question)

  const blocks: RenderBlock[] = []

  splitted.segments.forEach((segment, index) => {
    const isLast = index === splitted.segments.length - 1

    const segmentNodes =
      index === 0
        ? prependQuestionMarkerToNodes(marker, markdownToNodes(segment))
        : markdownToNodes(segment)

    if (segmentNodes.length > 0) {
      blocks.push(makeBlock(measureCtx, segmentNodes, columnWidthPx, imageMap, mathAssetMap))
    }

    const answerSpaceNodes: RenderNode[] = [
      {
        type: 'space',
        heightMm: unitSpaceMm,
      },
    ]
    blocks.push(makeBlock(measureCtx, answerSpaceNodes, columnWidthPx, imageMap, mathAssetMap))

    if (isLast && splitted.tail.trim().length > 0) {
      const tailNodes = markdownToNodes(splitted.tail)
      if (tailNodes.length > 0) {
        blocks.push(makeBlock(measureCtx, tailNodes, columnWidthPx, imageMap, mathAssetMap))
      }
    }
  })

  const trailingAnswerSpaceNodes: RenderNode[] = [
    {
      type: 'space',
      heightMm: spacingConfig.subjectiveAfterAnswerSpaceMm,
    },
  ]
  blocks.push(makeBlock(measureCtx, trailingAnswerSpaceNodes, columnWidthPx, imageMap, mathAssetMap))

  if (includeAnalysis) {
    blocks.push(
      ...buildAnalysisBlocks(
        question.analysis,
        measureCtx,
        columnWidthPx,
        imageMap,
        mathAssetMap,
        spacingConfig,
      ),
    )
  }

  return {
    type: 'subjective',
    blocks,
    totalHeightPx: blocks.reduce((sum, item) => sum + item.heightPx, 0),
  }
}

function resolveBindingSide(
  pageNumber: number,
  firstPageBindingSide: PdfExportSpacingConfig['firstPageBindingSide'],
): 'left' | 'right' {
  if (pageNumber % 2 === 1) {
    return firstPageBindingSide
  }
  return firstPageBindingSide === 'left' ? 'right' : 'left'
}

function drawLooseLeafHoleGuides(
  ctx: CanvasRenderingContext2D,
  bindingSide: 'left' | 'right',
  pageWidthPx: number,
) {
  const holeRadiusPx = mmToPx(LOOSE_LEAF_HOLE_DIAMETER_MM) / 2
  const holeCenterOffsetPx = mmToPx(LOOSE_LEAF_HOLE_OFFSET_MM)
  const holePitchPx = mmToPx(LOOSE_LEAF_HOLE_PITCH_MM)
  const firstHoleCenterYPx =
    (mmToPx(PAGE_HEIGHT_MM) - holePitchPx * (LOOSE_LEAF_HOLE_COUNT - 1)) / 2
  const centerX = bindingSide === 'left' ? holeCenterOffsetPx : pageWidthPx - holeCenterOffsetPx

  ctx.save()
  ctx.strokeStyle = '#b7bfcc'
  ctx.lineWidth = 1
  for (let index = 0; index < LOOSE_LEAF_HOLE_COUNT; index += 1) {
    const centerY = firstHoleCenterYPx + index * holePitchPx
    ctx.beginPath()
    ctx.arc(centerX, centerY, holeRadiusPx, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

function resolvePageLayout(args: {
  pageNumber: number
  pageWidthPx: number
  columnWidthPx: number
  gapPx: number
  dividerWidthPx: number
  baseMarginPx: number
  bindingMarginPx: number
  firstPageBindingSide: PdfExportSpacingConfig['firstPageBindingSide']
}): {
  leftX: number
  rightX: number
  dividerX: number
  bindingSide: 'left' | 'right'
} {
  const {
    pageNumber,
    pageWidthPx,
    columnWidthPx,
    gapPx,
    dividerWidthPx,
    baseMarginPx,
    bindingMarginPx,
    firstPageBindingSide,
  } = args
  const bindingSide = resolveBindingSide(pageNumber, firstPageBindingSide)
  const leftMarginPx = baseMarginPx + (bindingSide === 'left' ? bindingMarginPx : 0)
  const rightMarginPx = baseMarginPx + (bindingSide === 'right' ? bindingMarginPx : 0)
  const dividerX = leftMarginPx + columnWidthPx + gapPx / 2
  const rightX = pageWidthPx - rightMarginPx - columnWidthPx

  return {
    leftX: leftMarginPx,
    rightX,
    dividerX: dividerX + dividerWidthPx / 2,
    bindingSide,
  }
}

function createPageState(args: {
  pageWidthPx: number
  pageHeightPx: number
  contentTopPx: number
  contentBottomPx: number
  leftX: number
  rightX: number
  dividerX: number
  bindingSide: 'left' | 'right'
  renderLooseLeafHoles: boolean
}): PageState {
  const {
    pageWidthPx,
    pageHeightPx,
    contentTopPx,
    contentBottomPx,
    leftX,
    rightX,
    dividerX,
    bindingSide,
    renderLooseLeafHoles,
  } = args
  const canvas = document.createElement('canvas')
  canvas.width = pageWidthPx
  canvas.height = pageHeightPx

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('无法创建 Canvas 上下文。')
  }

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, pageWidthPx, pageHeightPx)

  ctx.strokeStyle = '#e2e5ea'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(dividerX, contentTopPx)
  ctx.lineTo(dividerX, contentBottomPx)
  ctx.stroke()

  if (renderLooseLeafHoles) {
    drawLooseLeafHoleGuides(ctx, bindingSide, pageWidthPx)
  }

  return {
    canvas,
    ctx,
    columnY: [contentTopPx, contentTopPx],
    leftX,
    rightX,
    dividerX,
    bindingSide,
  }
}

export async function exportQuestionsAsPdf(
  questions: Question[],
  options?: {
    includeAnalysis?: boolean
    spacingConfig?: PdfExportSpacingConfig
  },
): Promise<{
  ok: boolean
  message: string
}> {
  if (questions.length === 0) {
    return {
      ok: false,
      message: '当前筛选下暂无题目可导出。',
    }
  }

  const pageWidthPx = Math.round(mmToPx(PAGE_WIDTH_MM))
  const pageHeightPx = Math.round(mmToPx(PAGE_HEIGHT_MM))
  const baseMarginPx = mmToPx(PAGE_MARGIN_MM)
  const contentTopPx = baseMarginPx
  const contentBottomPx = pageHeightPx - baseMarginPx
  const contentHeightPx = contentBottomPx - contentTopPx

  const spacingConfig = options?.spacingConfig ?? DEFAULT_PDF_EXPORT_SPACING_CONFIG
  const bindingMarginPx = mmToPx(spacingConfig.bindingMarginMm)
  const contentWidthPx = pageWidthPx - baseMarginPx * 2 - bindingMarginPx
  const gapPx = mmToPx(COLUMN_GAP_MM)
  const dividerWidthPx = 1
  const columnWidthPx = Math.floor((contentWidthPx - gapPx - dividerWidthPx) / 2)

  const measureCanvas = document.createElement('canvas')
  const measureCtx = measureCanvas.getContext('2d')
  if (!measureCtx) {
    return {
      ok: false,
      message: '初始化测量画布失败，无法导出 PDF。',
    }
  }

  const includeAnalysis = options?.includeAnalysis === true
  const [imageMap, mathAssetMap] = await Promise.all([
    buildImageMap(questions, includeAnalysis),
    buildMathAssetMap(questions, includeAnalysis),
  ])

  const plans = questions.map((question) => {
    if (question.type === 'choice') {
      return buildChoicePlan(
        question,
        measureCtx,
        columnWidthPx,
        imageMap,
        mathAssetMap,
        includeAnalysis,
        spacingConfig,
      )
    }
    if (question.type === 'choiceGroup') {
      return buildChoiceGroupPlan(
        question,
        measureCtx,
        columnWidthPx,
        imageMap,
        mathAssetMap,
        includeAnalysis,
        spacingConfig,
      )
    }
    if (question.type === 'blank') {
      return buildBlankPlan(
        question,
        measureCtx,
        columnWidthPx,
        imageMap,
        mathAssetMap,
        includeAnalysis,
        spacingConfig,
      )
    }
    return buildSubjectivePlan(
      question,
      measureCtx,
      columnWidthPx,
      imageMap,
      mathAssetMap,
      includeAnalysis,
      spacingConfig,
    )
  })

  const sortedPlans = [...plans].sort((left, right) => right.totalHeightPx - left.totalHeightPx)

  const pages: PageState[] = [
    (() => {
      const layout = resolvePageLayout({
        pageNumber: 1,
        pageWidthPx,
        columnWidthPx,
        gapPx,
        dividerWidthPx,
        baseMarginPx,
        bindingMarginPx,
        firstPageBindingSide: spacingConfig.firstPageBindingSide,
      })
      return createPageState({
        pageWidthPx,
        pageHeightPx,
        contentTopPx,
        contentBottomPx,
        leftX: layout.leftX,
        rightX: layout.rightX,
        dividerX: layout.dividerX,
        bindingSide: layout.bindingSide,
        renderLooseLeafHoles: spacingConfig.renderLooseLeafHoles,
      })
    })(),
  ]

  let pageIndex = 0
  let columnIndex: 0 | 1 = 0

  const currentPage = () => pages[pageIndex]
  const currentY = () => currentPage().columnY[columnIndex]
  const remainingInCurrentColumn = () => contentBottomPx - currentY()

  const moveToNextColumnOrPage = () => {
    if (columnIndex === 0) {
      columnIndex = 1
      return
    }

    pageIndex += 1
    const layout = resolvePageLayout({
      pageNumber: pageIndex + 1,
      pageWidthPx,
      columnWidthPx,
      gapPx,
      dividerWidthPx,
      baseMarginPx,
      bindingMarginPx,
      firstPageBindingSide: spacingConfig.firstPageBindingSide,
    })
    pages.push(
      createPageState({
        pageWidthPx,
        pageHeightPx,
        contentTopPx,
        contentBottomPx,
        leftX: layout.leftX,
        rightX: layout.rightX,
        dividerX: layout.dividerX,
        bindingSide: layout.bindingSide,
        renderLooseLeafHoles: spacingConfig.renderLooseLeafHoles,
      }),
    )
    columnIndex = 0
  }

  const drawBlockOnCurrentColumn = (block: RenderBlock) => {
    const page = currentPage()
    const x = columnIndex === 0 ? page.leftX : page.rightX
    const y = page.columnY[columnIndex]

    const endY = layoutAndDrawNodes({
      ctx: page.ctx,
      nodes: block.nodes,
      x,
      y,
      widthPx: columnWidthPx,
      imageMap,
      mathAssetMap,
      draw: true,
    })

    page.columnY[columnIndex] = endY
  }

  const measureNodesHeight = (nodes: RenderNode[]): number => {
    if (nodes.length === 0) return 0
    const block = makeBlock(measureCtx, nodes, columnWidthPx, imageMap, mathAssetMap)
    return block.heightPx
  }

  const splitNodeForHeight = (
    node: RenderNode,
    maxHeight: number,
  ): { head: RenderNode; tail: RenderNode } | null => {
    if (maxHeight <= 0) {
      return null
    }

    if (node.type === 'text') {
      const fontWeight = node.bold ? 700 : 400
      const fontFamily = node.fontFamily ?? QUESTION_FONT_FAMILY
      measureCtx.font = `${fontWeight} ${node.fontSize}px ${fontFamily}`
      const lines = layoutRichTextLines({
        text: node.text,
        ctx: measureCtx,
        fontSize: node.fontSize,
        maxWidth: columnWidthPx,
        bold: node.bold,
        fontFamily,
        color: node.color,
        mathAssetMap,
      })
      const split = splitRichTextLinesByHeight(lines, maxHeight)
      if (!split) {
        return null
      }
      return {
        head: {
          type: 'richTextLines',
          lines: split.head,
          fontSize: node.fontSize,
          bold: node.bold,
          fontFamily: node.fontFamily,
          color: node.color,
        },
        tail: {
          type: 'richTextLines',
          lines: split.tail,
          fontSize: node.fontSize,
          bold: node.bold,
          fontFamily: node.fontFamily,
          color: node.color,
        },
      }
    }

    if (node.type === 'richText') {
      const lines = layoutRichTextSegmentLines({
        segments: node.segments,
        ctx: measureCtx,
        fontSize: node.fontSize,
        maxWidth: columnWidthPx,
        bold: node.bold,
        fontFamily: node.fontFamily,
        color: node.color,
        mathAssetMap,
      })
      const split = splitRichTextLinesByHeight(lines, maxHeight)
      if (!split) {
        return null
      }
      return {
        head: {
          type: 'richTextLines',
          lines: split.head,
          fontSize: node.fontSize,
          bold: node.bold,
          fontFamily: node.fontFamily,
          color: node.color,
        },
        tail: {
          type: 'richTextLines',
          lines: split.tail,
          fontSize: node.fontSize,
          bold: node.bold,
          fontFamily: node.fontFamily,
          color: node.color,
        },
      }
    }

    if (node.type === 'richTextLines') {
      const split = splitRichTextLinesByHeight(node.lines, maxHeight)
      if (!split) {
        return null
      }
      return {
        head: {
          type: 'richTextLines',
          lines: split.head,
          fontSize: node.fontSize,
          bold: node.bold,
          fontFamily: node.fontFamily,
          color: node.color,
        },
        tail: {
          type: 'richTextLines',
          lines: split.tail,
          fontSize: node.fontSize,
          bold: node.bold,
          fontFamily: node.fontFamily,
          color: node.color,
        },
      }
    }

    if (node.type === 'table') {
      return splitTableNodeByHeight(node, measureCtx, columnWidthPx, maxHeight, mathAssetMap)
    }

    return null
  }

  const drawOversizedBlock = (block: RenderBlock) => {
    const queue = [...block.nodes]

    while (queue.length > 0) {
      let pickedCount = 0
      let chosenHeight = 0

      for (let size = 1; size <= queue.length; size += 1) {
        const candidateNodes = queue.slice(0, size)
        const candidateHeight = measureNodesHeight(candidateNodes)
        if (candidateHeight <= remainingInCurrentColumn()) {
          pickedCount = size
          chosenHeight = candidateHeight
          continue
        }
        break
      }

      if (pickedCount > 0) {
        const drawNodes = queue.splice(0, pickedCount)
        drawBlockOnCurrentColumn({
          nodes: drawNodes,
          heightPx: Math.ceil(chosenHeight),
        })
        continue
      }

      const firstNode = queue[0]
      const firstHeight = measureNodesHeight([firstNode])

      if (firstHeight <= contentHeightPx) {
        moveToNextColumnOrPage()
        continue
      }

      let split = splitNodeForHeight(firstNode, remainingInCurrentColumn())
      if (!split) {
        moveToNextColumnOrPage()
        split = splitNodeForHeight(firstNode, contentHeightPx)
      }

      if (!split) {
        // 兜底：无法继续拆分时强制绘制并移除，避免死循环。
        queue.shift()
        drawBlockOnCurrentColumn({
          nodes: [firstNode],
          heightPx: Math.min(firstHeight, remainingInCurrentColumn()),
        })
        if (queue.length > 0) {
          moveToNextColumnOrPage()
        }
        continue
      }

      drawBlockOnCurrentColumn({
        nodes: [split.head],
        heightPx: Math.ceil(measureNodesHeight([split.head])),
      })
      queue[0] = split.tail

      if (remainingInCurrentColumn() <= 0) {
        moveToNextColumnOrPage()
      }
    }
  }

  const drawSimplePlan = (plan: RenderPlan) => {
    const block = plan.blocks[0]
    if (!block) return

    if (block.heightPx <= remainingInCurrentColumn()) {
      drawBlockOnCurrentColumn(block)
      return
    }

    if (block.heightPx <= contentHeightPx) {
      let safety = 0
      while (block.heightPx > remainingInCurrentColumn() && safety < 10) {
        moveToNextColumnOrPage()
        safety += 1
      }
      drawBlockOnCurrentColumn(block)
      return
    }

    drawOversizedBlock(block)
  }

  const placeWholeBlock = (block: RenderBlock): boolean => {
    if (block.heightPx <= remainingInCurrentColumn()) {
      drawBlockOnCurrentColumn(block)
      return true
    }

    if (block.heightPx <= contentHeightPx) {
      let safety = 0
      while (block.heightPx > remainingInCurrentColumn() && safety < 10) {
        moveToNextColumnOrPage()
        safety += 1
      }
      if (block.heightPx <= remainingInCurrentColumn()) {
        drawBlockOnCurrentColumn(block)
        return true
      }
    }

    return false
  }

  const drawChoiceLikePlan = (plan: RenderPlan) => {
    if (plan.blocks.length === 0) {
      return
    }

    const [coreBlock, ...analysisBlocks] = plan.blocks
    if (coreBlock) {
      const placed = placeWholeBlock(coreBlock)
      if (!placed) {
        // 题面+选项理论上不分页；仅在单栏放不下时兜底拆分，避免内容丢失。
        drawOversizedBlock(coreBlock)
      }
    }

    for (const block of analysisBlocks) {
      const placed = placeWholeBlock(block)
      if (!placed) {
        drawOversizedBlock(block)
      }
    }
  }

  const drawSubjectivePlan = (plan: RenderPlan) => {
    const remainingCurrent = remainingInCurrentColumn()
    const rightRemaining =
      columnIndex === 0 ? contentBottomPx - currentPage().columnY[1] : 0
    const capacityWithoutPageBreak = remainingCurrent + rightRemaining

    if (plan.totalHeightPx > capacityWithoutPageBreak && plan.totalHeightPx <= contentHeightPx * 2) {
      if (!(columnIndex === 0 && currentPage().columnY[0] === contentTopPx && currentPage().columnY[1] === contentTopPx)) {
        pageIndex += 1
        const layout = resolvePageLayout({
          pageNumber: pageIndex + 1,
          pageWidthPx,
          columnWidthPx,
          gapPx,
          dividerWidthPx,
          baseMarginPx,
          bindingMarginPx,
          firstPageBindingSide: spacingConfig.firstPageBindingSide,
        })
        pages.push(
          createPageState({
            pageWidthPx,
            pageHeightPx,
            contentTopPx,
            contentBottomPx,
            leftX: layout.leftX,
            rightX: layout.rightX,
            dividerX: layout.dividerX,
            bindingSide: layout.bindingSide,
            renderLooseLeafHoles: spacingConfig.renderLooseLeafHoles,
          }),
        )
        columnIndex = 0
      }
    }

    for (const block of plan.blocks) {
      if (block.heightPx <= remainingInCurrentColumn()) {
        drawBlockOnCurrentColumn(block)
        continue
      }
      if (block.heightPx <= contentHeightPx) {
        moveToNextColumnOrPage()
        if (block.heightPx <= remainingInCurrentColumn()) {
          drawBlockOnCurrentColumn(block)
          continue
        }
      }
      drawOversizedBlock(block)
    }
  }

  for (const plan of sortedPlans) {
    if (plan.type === 'subjective') {
      drawSubjectivePlan(plan)
    } else if (plan.type === 'choice' || plan.type === 'choiceGroup' || plan.type === 'blank') {
      drawChoiceLikePlan(plan)
    } else {
      drawSimplePlan(plan)
    }
  }

  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: [PAGE_WIDTH_MM, PAGE_HEIGHT_MM],
    compress: true,
  })

  pages.forEach((page, index) => {
    if (index > 0) {
      pdf.addPage([PAGE_WIDTH_MM, PAGE_HEIGHT_MM], 'portrait')
    }
    const dataUrl = page.canvas.toDataURL('image/png')
    pdf.addImage(dataUrl, 'PNG', 0, 0, PAGE_WIDTH_MM, PAGE_HEIGHT_MM)
  })

  const now = new Date()
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')

  const fileTag = includeAnalysis ? '题面及答案导出' : '题面导出'
  pdf.save(`${fileTag}-B5-${stamp}.pdf`)

  return {
    ok: true,
    message: includeAnalysis
      ? `已导出 ${pages.length} 页 PDF（含解析）。`
      : `已导出 ${pages.length} 页 PDF。`,
  }
}
