import { useMemo, useRef, useState } from 'react'
import MarkdownRenderer from './MarkdownRenderer'

interface MarkdownEditorProps {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  allowImages?: boolean
  onResolveImageDataUrl?: (dataUrl: string) => string
  resolveMarkdownForPreview?: (value: string) => string
  previewLabel?: string
  minRows?: number
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

function MarkdownEditor({
  label,
  value,
  onChange,
  placeholder,
  allowImages = false,
  onResolveImageDataUrl,
  resolveMarkdownForPreview,
  previewLabel = '预览',
  minRows = 6,
}: MarkdownEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [previewMode, setPreviewMode] = useState(false)
  const previewValue = useMemo(
    () => (resolveMarkdownForPreview ? resolveMarkdownForPreview(value) : value),
    [resolveMarkdownForPreview, value],
  )

  const onPickImage = () => {
    inputRef.current?.click()
  }

  const onImageSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return
    }

    const images = await Promise.all(
      Array.from(files).map(async (file) => {
        const dataUrl = await readFileAsDataUrl(file)
        const imageUrl = onResolveImageDataUrl ? onResolveImageDataUrl(dataUrl) : dataUrl
        return `![${file.name}](${imageUrl})`
      }),
    )

    const separator = value.trim().length > 0 ? '\n\n' : ''
    onChange(`${value}${separator}${images.join('\n')}`)
  }

  return (
    <section className={`editor-block ${previewMode ? 'is-preview' : 'is-editing'}`}>
      <div className="editor-head">
        <span>{label}</span>
        <div className="editor-head-actions">
          {allowImages && !previewMode ? (
            <button type="button" className="editor-image-btn" onClick={onPickImage}>
              插入图片
            </button>
          ) : null}
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
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          rows={minRows}
        />
        <div className="editor-preview">
          <p>{previewLabel}</p>
          <MarkdownRenderer value={previewValue} />
        </div>
      </div>
      {allowImages ? (
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            void onImageSelected(event.target.files)
            event.currentTarget.value = ''
          }}
        />
      ) : null}
    </section>
  )
}

export default MarkdownEditor
