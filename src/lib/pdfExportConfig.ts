export interface PdfExportSpacingConfig {
  choiceStemGapMm: number
  choiceStemImageTopGapMm: number
  choiceStemImageBottomGapMm: number
  choiceOptionGapMm: number
  choiceAfterOptionsGapMm: number
  choiceGroupMaterialGapMm: number
  choiceGroupQuestionGapMm: number
  blankStemImageTopGapMm: number
  blankStemImageBottomGapMm: number
  blankBaseAnswerSpaceMm: number
  blankPerExtraAnswerSpaceMm: number
  subjectiveAnswerSpaceMm: number
  subjectiveMathAnswerSpaceMm: number
  subjectiveAfterAnswerSpaceMm: number
  analysisTopGapMm: number
  bindingMarginMm: number
  firstPageBindingSide: 'left' | 'right'
  renderLooseLeafHoles: boolean
}

type NumericPdfExportSpacingKey = Exclude<
  keyof PdfExportSpacingConfig,
  'firstPageBindingSide' | 'renderLooseLeafHoles'
>

export interface PdfExportSpacingField {
  key: NumericPdfExportSpacingKey
  label: string
  description: string
  min: number
  max: number
  step: number
}

export const PDF_EXPORT_SPACING_STORAGE_KEY = 'mistakes.pdf-export-spacing.v2'

export const DEFAULT_PDF_EXPORT_SPACING_CONFIG: PdfExportSpacingConfig = {
  choiceStemGapMm: 10,
  choiceStemImageTopGapMm: 5,
  choiceStemImageBottomGapMm: 8,
  choiceOptionGapMm: 10,
  choiceAfterOptionsGapMm: 30,
  choiceGroupMaterialGapMm: 12,
  choiceGroupQuestionGapMm: 14,
  blankStemImageTopGapMm: 5,
  blankStemImageBottomGapMm: 8,
  blankBaseAnswerSpaceMm: 50,
  blankPerExtraAnswerSpaceMm: 10,
  subjectiveAnswerSpaceMm: 50,
  subjectiveMathAnswerSpaceMm: 70,
  subjectiveAfterAnswerSpaceMm: 50,
  analysisTopGapMm: 5,
  bindingMarginMm: 4,
  firstPageBindingSide: 'left',
  renderLooseLeafHoles: true,
}

export const PDF_EXPORT_SPACING_FIELDS: PdfExportSpacingField[] = [
  {
    key: 'choiceStemGapMm',
    label: '选择题题面后间隔',
    description: '无图片时，题面与选项之间的空白。',
    min: 0,
    max: 60,
    step: 1,
  },
  {
    key: 'choiceStemImageTopGapMm',
    label: '选择题题面到图片间隔',
    description: '选择题题面文字后，紧接图片前的空白。',
    min: 0,
    max: 40,
    step: 1,
  },
  {
    key: 'choiceStemImageBottomGapMm',
    label: '选择题图片后间隔',
    description: '选择题题面图片与选项之间的空白。',
    min: 0,
    max: 40,
    step: 1,
  },
  {
    key: 'choiceOptionGapMm',
    label: '选择题选项间隔',
    description: '同一题各选项之间的空白。',
    min: 0,
    max: 40,
    step: 1,
  },
  {
    key: 'choiceAfterOptionsGapMm',
    label: '选择题尾部留白',
    description: '选择题全部选项结束后的额外留白。',
    min: 0,
    max: 80,
    step: 1,
  },
  {
    key: 'choiceGroupMaterialGapMm',
    label: '多空材料后间隔',
    description: '共享材料与第 1 道子题之间的空白。',
    min: 0,
    max: 60,
    step: 1,
  },
  {
    key: 'choiceGroupQuestionGapMm',
    label: '多空子题间隔',
    description: '同一材料下各子题之间的空白。',
    min: 0,
    max: 60,
    step: 1,
  },
  {
    key: 'blankStemImageTopGapMm',
    label: '填空题题面到图片间隔',
    description: '填空题题面文字后，紧接图片前的空白。',
    min: 0,
    max: 40,
    step: 1,
  },
  {
    key: 'blankStemImageBottomGapMm',
    label: '填空题图片后间隔',
    description: '填空题题面图片与作答区之间的空白。',
    min: 0,
    max: 40,
    step: 1,
  },
  {
    key: 'blankBaseAnswerSpaceMm',
    label: '填空题基础留白',
    description: '填空题第 1 空对应的基础作答区高度。',
    min: 10,
    max: 120,
    step: 1,
  },
  {
    key: 'blankPerExtraAnswerSpaceMm',
    label: '填空题每增一空追加留白',
    description: '填空题空位超过 1 个时，每多一空追加的高度。',
    min: 0,
    max: 60,
    step: 1,
  },
  {
    key: 'subjectiveAnswerSpaceMm',
    label: '主观题普通留白',
    description: '主观题每个作答区的默认高度。',
    min: 10,
    max: 140,
    step: 1,
  },
  {
    key: 'subjectiveMathAnswerSpaceMm',
    label: '主观题数学留白',
    description: '数学学科主观题每个作答区的默认高度。',
    min: 10,
    max: 180,
    step: 1,
  },
  {
    key: 'subjectiveAfterAnswerSpaceMm',
    label: '主观题尾部留白',
    description: '主观题最后一个作答区后的额外留白。',
    min: 0,
    max: 120,
    step: 1,
  },
  {
    key: 'analysisTopGapMm',
    label: '解析前间隔',
    description: '题面与解析之间的空白。',
    min: 0,
    max: 40,
    step: 1,
  },
  {
    key: 'bindingMarginMm',
    label: '装订侧额外边距',
    description: '打印时装订侧追加的安全留白，默认用于 B5 活页打孔避让。',
    min: 0,
    max: 20,
    step: 0.5,
  },
]

function normalizeSpacingValue(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) {
    return fallback
  }
  return Math.min(max, Math.max(min, numeric))
}

export function sanitizePdfExportSpacingConfig(
  input: unknown,
): PdfExportSpacingConfig {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}

  const sanitized = PDF_EXPORT_SPACING_FIELDS.reduce<PdfExportSpacingConfig>(
    (result, field) => {
      result[field.key] = normalizeSpacingValue(
        source[field.key],
        DEFAULT_PDF_EXPORT_SPACING_CONFIG[field.key],
        field.min,
        field.max,
      )
      return result
    },
    { ...DEFAULT_PDF_EXPORT_SPACING_CONFIG },
  )

  sanitized.firstPageBindingSide =
    source.firstPageBindingSide === 'right'
      ? 'right'
      : DEFAULT_PDF_EXPORT_SPACING_CONFIG.firstPageBindingSide
  sanitized.renderLooseLeafHoles =
    typeof source.renderLooseLeafHoles === 'boolean'
      ? source.renderLooseLeafHoles
      : DEFAULT_PDF_EXPORT_SPACING_CONFIG.renderLooseLeafHoles

  return sanitized
}

export function loadPdfExportSpacingConfig(): PdfExportSpacingConfig {
  try {
    const raw = localStorage.getItem(PDF_EXPORT_SPACING_STORAGE_KEY)
    if (!raw) {
      return { ...DEFAULT_PDF_EXPORT_SPACING_CONFIG }
    }
    return sanitizePdfExportSpacingConfig(JSON.parse(raw) as unknown)
  } catch {
    return { ...DEFAULT_PDF_EXPORT_SPACING_CONFIG }
  }
}

export function savePdfExportSpacingConfig(config: PdfExportSpacingConfig): void {
  localStorage.setItem(PDF_EXPORT_SPACING_STORAGE_KEY, JSON.stringify(config))
}
