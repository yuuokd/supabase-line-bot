export type LineEventType = "follow" | "unfollow" | "message" | "postback"

export interface LineEvent {
  type: LineEventType
  replyToken?: string
  source: { userId: string }
  message?: { type: string; text?: string }
  postback?: { data: string }
}

export interface PostbackPayload {
  action: "start_survey" | "answer" | "start_free_text"
  surveyId: string
  questionId?: string
  optionId?: string
  optionValue?: string
  orderIndex?: number
}

export interface FlexTemplate {
  id: string
  name: string
  category: string
  layout_json: Record<string, unknown>
}

export interface MessageNode {
  id: string
  story_id: string
  prev_node_id?: string | null
  next_node_id?: string | null
  flex_template_id: string
  title?: string | null
  body_text?: string | null
  image_url?: string | null
}

export interface Customer {
  id: string
  line_user_id: string
  line_display_name?: string | null
  opt_in: boolean
  is_blocked: boolean
}

export interface Story {
  id: string
  title: string
}

export interface Survey {
  id: string
  node_id: string
  title: string
}

export interface SurveyQuestion {
  id: string
  survey_id: string
  order_index: number
  question_text: string
  required: boolean
  flex_template_id: string
}

export interface SurveyOption {
  id: string
  question_id: string
  order_index: number
  label: string
  value: string
}

export interface SurveySession {
  id: string
  survey_id: string
  customer_id: string
  status: string
  current_order_index: number | null
}

export interface SurveyResponse {
  id: string
  survey_id: string
  customer_id: string
  submitted_at?: string | null
}

export interface AnswerRecord {
  questionId: string
  orderIndex: number
  value?: string | null
  optionId?: string | null
  textAnswer?: string | null
}

export type LineMessage = Record<string, unknown>
