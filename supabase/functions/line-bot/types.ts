// LINE Messaging API から受け取るイベントタイプ
export type LineEventType = "follow" | "unfollow" | "message" | "postback"

// Webhook で受ける LINE イベントの簡易型
export interface LineEvent {
  type: LineEventType
  replyToken?: string
  source: { userId: string }
  message?: { type: string; text?: string }
  postback?: { data: string }
}

// postback.data に含める情報の型。action に応じて survey/flow を進行させる。
export interface PostbackPayload {
  action: "start_survey" | "answer" | "start_free_text" | "complete_flow"
  surveyId?: string
  questionId?: string
  optionId?: string
  optionValue?: string
  orderIndex?: number
  storyId?: string
  nodeId?: string
}

// flex_templates テーブルの型
export interface FlexTemplate {
  id: string
  name: string
  category: string
  layout_json: Record<string, unknown>
}

// message_nodes テーブルの型
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

// customers テーブルの型
export interface Customer {
  id: string
  line_user_id: string
  line_display_name?: string | null
  opt_in: boolean
  is_blocked: boolean
}

// stories テーブルの型
export interface Story {
  id: string
  title: string
}

// surveys テーブルの型
export interface Survey {
  id: string
  node_id: string
  title: string
}

// survey_questions テーブルの型
export interface SurveyQuestion {
  id: string
  survey_id: string
  order_index: number
  question_title?: string | null
  question_text: string
  required: boolean
  flex_template_id: string
}

// survey_options テーブルの型
export interface SurveyOption {
  id: string
  question_id: string
  order_index: number
  label: string
  value: string
}

// survey_sessions テーブルの型
export interface SurveySession {
  id: string
  survey_id: string
  customer_id: string
  status: string
  current_order_index: number | null
}

// survey_responses テーブルの型
export interface SurveyResponse {
  id: string
  survey_id: string
  customer_id: string
  submitted_at?: string | null
}

// 回答を集計した簡易レコード（orderIndex 付き）
export interface AnswerRecord {
  questionId: string
  orderIndex: number
  value?: string | null
  optionId?: string | null
  textAnswer?: string | null
}

// LINE 送信用メッセージの汎用型
export type LineMessage = Record<string, unknown>
