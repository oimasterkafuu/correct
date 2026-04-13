export type SubjectKey =
  | 'chinese'
  | 'math'
  | 'english'
  | 'politics'
  | 'history'
  | 'geography'
  | 'physics'
  | 'chemistry'
  | 'biology'
  | 'other'

export type QuestionType = 'choice' | 'choiceGroup' | 'blank' | 'subjective'
export type ChoiceMode = 'single' | 'double' | 'multiple'
export type OptionStyle = 'latin' | 'circle'

export interface SubjectInfo {
  key: SubjectKey
  label: string
  color: string
  softColor: string
}

export interface AiSettings {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
}

export interface BaseQuestion {
  id: string
  subject: SubjectKey
  type: QuestionType
  stem: string
  normalizedStem: string
  createdAt: string
  updatedAt: string
}

export interface ChoiceQuestion extends BaseQuestion {
  type: 'choice'
  choiceMode: ChoiceMode
  optionStyle: OptionStyle
  optionCount: number
  options: string[]
  correctAnswers: number[]
  analysis: string
}

export interface ChoiceSubQuestion {
  id: string
  stem: string
  normalizedStem: string
  choiceMode: ChoiceMode
  optionStyle: OptionStyle
  optionCount: number
  options: string[]
  correctAnswers: number[]
  analysis: string
}

export interface ChoiceGroupQuestion extends BaseQuestion {
  type: 'choiceGroup'
  subquestions: ChoiceSubQuestion[]
}

export interface BlankQuestion extends BaseQuestion {
  type: 'blank'
  blankCount: number
  answers: string[]
  analysis: string
}

export interface SubjectiveQuestion extends BaseQuestion {
  type: 'subjective'
  areaCount: number
  answers: string[]
  analysis: string
}

export type Question = ChoiceQuestion | ChoiceGroupQuestion | BlankQuestion | SubjectiveQuestion
