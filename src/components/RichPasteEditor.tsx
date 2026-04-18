import { useEffect, useMemo, useRef, useState } from 'react'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import MarkdownRenderer from './MarkdownRenderer'

interface RichPasteEditorProps {
  label: string
  htmlValue: string
  markdownValue: string
  onHtmlChange: (value: string) => void
  onMarkdownChange: (value: string) => void
  placeholder?: string
  onResolveImageDataUrl?: (dataUrl: string) => string
  resolveMarkdownForPreview?: (value: string) => string
  previewLabel?: string
  minHeight?: number
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('\n', '&#10;')
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })
  service.use(gfm)
  service.addRule('import-images', {
    filter(node) {
      return node.nodeName === 'IMG'
    },
    replacement(_content, node) {
      if (!(node instanceof HTMLImageElement)) {
        return ''
      }
      const markdownSrc = node.getAttribute('data-import-markdown-src') || node.getAttribute('src') || ''
      const alt = node.getAttribute('alt') || ''
      if (!markdownSrc.trim()) {
        return ''
      }
      return `![${alt}](${markdownSrc.trim()})`
    },
  })
  return service
}

function sanitizeImportedRoot(root: HTMLElement): void {
  root.querySelectorAll('script, style, iframe, object, embed, meta, link').forEach((node) => node.remove())

  const allowedAttributes = new Set([
    'href',
    'src',
    'alt',
    'title',
    'colspan',
    'rowspan',
    'data-import-markdown-src',
  ])

  root.querySelectorAll('*').forEach((node) => {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) {
        node.removeAttribute(attr.name)
        continue
      }

      if (!allowedAttributes.has(name)) {
        node.removeAttribute(attr.name)
      }
    }
  })
}

function normalizeImageNodes(root: HTMLElement, rememberImage?: (dataUrl: string) => string): void {
  root.querySelectorAll('img').forEach((node, index) => {
    const rawSrc = (node.getAttribute('src') || '').trim()
    if (!rawSrc) {
      return
    }

    const isDataImage = /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(rawSrc)
    if (isDataImage && rememberImage) {
      const imageId = rememberImage(rawSrc)
      node.setAttribute('data-import-markdown-src', imageId)
      if (!node.getAttribute('alt')) {
        node.setAttribute('alt', `粘贴图片${index + 1}`)
      }
      return
    }

    if (!node.getAttribute('data-import-markdown-src')) {
      node.setAttribute('data-import-markdown-src', rawSrc)
    }
  })
}

function buildEditorHtmlFromText(text: string): string {
  const normalized = text.replace(/\r/g, '').trim()
  if (!normalized) {
    return ''
  }

  return normalized
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br />')}</p>`)
    .join('')
}

function buildMarkdownFromEditorHtml(
  html: string,
  turndownService: TurndownService,
  rememberImage?: (dataUrl: string) => string,
): string {
  const container = document.createElement('div')
  container.innerHTML = html
  sanitizeImportedRoot(container)
  normalizeImageNodes(container, rememberImage)

  const hasContent =
    container.textContent?.trim().length ||
    container.querySelector('img, table, ul, ol, blockquote, hr, pre')
  if (!hasContent) {
    return ''
  }

  return turndownService
    .turndown(container.innerHTML)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function buildImageHtml(
  files: File[],
  rememberImage?: (dataUrl: string) => string,
): Promise<string> {
  const segments = await Promise.all(
    files.map(async (file, index) => {
      const dataUrl = await readFileAsDataUrl(file)
      const markdownSrc = rememberImage ? rememberImage(dataUrl) : dataUrl
      const alt = file.name?.trim() || `粘贴图片${index + 1}`
      return `<p><img src="${escapeAttribute(dataUrl)}" data-import-markdown-src="${escapeAttribute(
        markdownSrc,
      )}" alt="${escapeAttribute(alt)}" /></p>`
    }),
  )

  return segments.join('')
}

async function buildEditorHtmlFromClipboard(
  clipboard: DataTransfer,
  rememberImage?: (dataUrl: string) => string,
): Promise<string> {
  const rawHtml = clipboard.getData('text/html').trim()
  const rawText = clipboard.getData('text/plain')
  const imageFiles = Array.from(clipboard.items)
    .filter((item) => item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file instanceof File)

  const hasHtmlImages = /<img[\s>]/i.test(rawHtml)

  let content = ''
  if (rawHtml) {
    const container = document.createElement('div')
    container.innerHTML = rawHtml
    sanitizeImportedRoot(container)
    normalizeImageNodes(container, rememberImage)
    content = container.innerHTML.trim()
  } else if (rawText.trim()) {
    content = buildEditorHtmlFromText(rawText)
  }

  if (imageFiles.length > 0 && (!rawHtml || !hasHtmlImages)) {
    const imageHtml = await buildImageHtml(imageFiles, rememberImage)
    content = content ? `${content}${imageHtml}` : imageHtml
  }

  return content
}

function placeCaretAtEnd(element: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(false)
  const selection = window.getSelection()
  if (!selection) {
    return
  }
  selection.removeAllRanges()
  selection.addRange(range)
}

function insertHtmlAtSelection(container: HTMLElement, html: string): void {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || !container.contains(selection.anchorNode)) {
    container.insertAdjacentHTML('beforeend', html)
    placeCaretAtEnd(container)
    return
  }

  const range = selection.getRangeAt(0)
  range.deleteContents()
  const fragment = range.createContextualFragment(html)
  const lastNode = fragment.lastChild
  range.insertNode(fragment)

  if (lastNode) {
    range.setStartAfter(lastNode)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }
}

function RichPasteEditor({
  label,
  htmlValue,
  markdownValue,
  onHtmlChange,
  onMarkdownChange,
  placeholder,
  onResolveImageDataUrl,
  resolveMarkdownForPreview,
  previewLabel = '预览',
  minHeight = 240,
}: RichPasteEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [previewMode, setPreviewMode] = useState(false)
  const turndownService = useMemo(() => createTurndownService(), [])
  const previewValue = useMemo(
    () => (resolveMarkdownForPreview ? resolveMarkdownForPreview(markdownValue) : markdownValue),
    [markdownValue, resolveMarkdownForPreview],
  )

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) {
      return
    }

    if (editor.innerHTML !== htmlValue) {
      editor.innerHTML = htmlValue
    }
  }, [htmlValue])

  const syncFromEditor = () => {
    const editor = editorRef.current
    if (!editor) {
      return
    }

    const nextHtml = editor.innerHTML
    const nextMarkdown = buildMarkdownFromEditorHtml(nextHtml, turndownService, onResolveImageDataUrl)

    if (!nextMarkdown) {
      if (nextHtml !== '') {
        editor.innerHTML = ''
      }
      onHtmlChange('')
      onMarkdownChange('')
      return
    }

    onHtmlChange(nextHtml)
    onMarkdownChange(nextMarkdown)
  }

  const insertImages = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return
    }

    const editor = editorRef.current
    if (!editor) {
      return
    }

    const imageHtml = await buildImageHtml(Array.from(files), onResolveImageDataUrl)
    editor.focus()
    insertHtmlAtSelection(editor, imageHtml)
    syncFromEditor()
  }

  const handlePaste = async (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()

    const editor = editorRef.current
    if (!editor) {
      return
    }

    const content = await buildEditorHtmlFromClipboard(event.clipboardData, onResolveImageDataUrl)
    if (!content.trim()) {
      return
    }

    editor.focus()
    insertHtmlAtSelection(editor, content)
    syncFromEditor()
  }

  return (
    <section className={`editor-block ${previewMode ? 'is-preview' : 'is-editing'}`}>
      <div className="editor-head">
        <span>{label}</span>
        <div className="editor-head-actions">
          <button
            type="button"
            className="editor-image-btn"
            onClick={() => inputRef.current?.click()}
          >
            插入图片
          </button>
          <button
            type="button"
            className="editor-toggle-btn"
            onClick={() => setPreviewMode((prev) => !prev)}
            aria-pressed={previewMode}
          >
            {previewMode ? '编辑' : '预览'}
          </button>
        </div>
      </div>

      <div className="editor-grid">
        <div
          ref={editorRef}
          className="rich-paste-surface"
          contentEditable
          suppressContentEditableWarning
          data-placeholder={placeholder || ''}
          style={{ minHeight }}
          onPaste={(event) => {
            void handlePaste(event)
          }}
          onInput={syncFromEditor}
          onBlur={syncFromEditor}
        />
        <div className="editor-preview">
          <p>{previewLabel}</p>
          <MarkdownRenderer value={previewValue} allowHtml />
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          void insertImages(event.target.files)
          event.currentTarget.value = ''
        }}
      />
    </section>
  )
}

export default RichPasteEditor
