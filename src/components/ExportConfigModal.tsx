import { useEffect } from 'react'
import {
  DEFAULT_PDF_EXPORT_SPACING_CONFIG,
  PDF_EXPORT_SPACING_FIELDS,
  type PdfExportSpacingConfig,
} from '../lib/pdfExportConfig'

interface ExportConfigModalProps {
  open: boolean
  targetLabel: string
  exporting: boolean
  config: PdfExportSpacingConfig
  onChange: (key: keyof PdfExportSpacingConfig, value: number) => void
  onClose: () => void
  onReset: () => void
  onSave: () => void
  onConfirm: () => void
}

function ExportConfigModal({
  open,
  targetLabel,
  exporting,
  config,
  onChange,
  onClose,
  onReset,
  onSave,
  onConfirm,
}: ExportConfigModalProps) {
  useEffect(() => {
    if (!open) {
      return undefined
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !exporting) {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [exporting, onClose, open])

  if (!open) {
    return null
  }

  return (
    <div className="modal-overlay" role="presentation" onClick={exporting ? undefined : onClose}>
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="导出配置"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h3>导出配置</h3>
            <p>当前准备导出：{targetLabel}。调整间隔后可先保存到本地，再开始下载。</p>
          </div>
          <button type="button" className="ghost-btn" onClick={onClose} disabled={exporting}>
            关闭
          </button>
        </header>

        <div className="modal-tip">
          <span>默认值</span>
          <p>
            点击“一键重置回默认”后，会把当前配置恢复到系统默认值并同步写入浏览器本地存储。
          </p>
        </div>

        <div className="export-config-grid">
          {PDF_EXPORT_SPACING_FIELDS.map((field) => {
            const currentValue = config[field.key]
            const defaultValue = DEFAULT_PDF_EXPORT_SPACING_CONFIG[field.key]
            return (
              <label key={field.key}>
                <span>{field.label}</span>
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={currentValue}
                  onChange={(event) => onChange(field.key, Number(event.target.value))}
                />
                <small>
                  {field.description} 默认值：{defaultValue} mm
                </small>
              </label>
            )
          })}
        </div>

        <footer className="modal-actions">
          <button type="button" className="ghost-btn" onClick={onReset} disabled={exporting}>
            一键重置回默认
          </button>
          <button type="button" className="ghost-btn" onClick={onSave} disabled={exporting}>
            保存到本地
          </button>
          <button type="button" className="primary-btn" onClick={onConfirm} disabled={exporting}>
            {exporting ? '导出中...' : '保存并导出'}
          </button>
        </footer>
      </section>
    </div>
  )
}

export default ExportConfigModal
