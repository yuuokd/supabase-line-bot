import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2"
import {
  AnswerRecord,
  Customer,
  FlexTemplate,
  MessageNode,
  Story,
  Survey,
  SurveyOption,
  SurveyQuestion,
  SurveyResponse,
  SurveySession,
} from "./types.ts"

// 顧客テーブル操作（follow/upsert, block, プロフィール更新など）
export class CustomerDAO {
  constructor(private client: SupabaseClient) {}

  async upsertFromFollow(
    lineUserId: string,
    displayName?: string | null,
  ): Promise<Customer | null> {
    // Manual upsert to avoid relying on DB conflict target
    const existing = await this.findByLineUserId(lineUserId)
    if (existing) {
      const { data, error } = await this.client
        .from("customers")
        .update({
          line_display_name: displayName ??
            existing.line_display_name ??
            null,
          opt_in: true,
          is_blocked: false,
          blocked_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .single()
      if (error) {
        console.error({ reason: "CustomerDAO.upsertFromFollow.update", error })
        return null
      }
      return data as Customer
    }

    const { data, error } = await this.client
      .from("customers")
      .insert({
        line_user_id: lineUserId,
        line_display_name: displayName ?? null,
        opt_in: true,
        is_blocked: false,
        blocked_at: null,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) {
      console.error({ reason: "CustomerDAO.upsertFromFollow.insert", error })
      return null
    }
    return data as Customer
  }

  async markBlocked(lineUserId: string): Promise<void> {
    const { error } = await this.client
      .from("customers")
      .update({
        is_blocked: true,
        opt_in: false,
        blocked_at: new Date().toISOString(),
      })
      .eq("line_user_id", lineUserId)
    if (error) console.error({ reason: "CustomerDAO.markBlocked", error })
  }

  async findByLineUserId(lineUserId: string): Promise<Customer | null> {
    const { data, error } = await this.client
      .from("customers")
      .select("*")
      .eq("line_user_id", lineUserId)
      .maybeSingle()
    if (error) {
      console.error({ reason: "CustomerDAO.findByLineUserId", error })
      return null
    }
    if (!data) return null
    return data as Customer
  }

  async updateProfile(
    customerId: string,
    fields: Partial<{
      grade_id: string | null
      major_id: string | null
      prefecture_id: string | null
      university_id: string | null
      opt_in: boolean
      is_blocked: boolean
    }>,
  ): Promise<void> {
    const { error } = await this.client
      .from("customers")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("id", customerId)
    if (error) console.error({ reason: "CustomerDAO.updateProfile", error })
  }
}

// ストーリーとノード関連のDAO（ストーリー特定・入口ノード特定・任意ノード取得）
export class StoryDAO {
  constructor(private client: SupabaseClient) {}

  // タイトルでストーリーを1件取得。初回プロフィールストーリーの特定に利用。
  async findByTitle(title: string): Promise<Story | null> {
    const { data, error } = await this.client
      .from("stories")
      .select("id,title")
      .eq("title", title)
      .limit(1)
      .single()
    if (error) {
      console.error({ reason: "StoryDAO.findByTitle", error })
      return null
    }
    return data as Story
  }

  // prev_node_id が null のノード（入口ノード）を1件取得。ストーリーの開始地点を決める。
  async findEntryNode(storyId: string): Promise<MessageNode | null> {
    const { data, error } = await this.client
      .from("message_nodes")
      .select("*")
      .eq("story_id", storyId)
      .is("prev_node_id", null)
      .limit(1)
      .single()

    if (error) {
      console.error({ reason: "StoryDAO.findEntryNode", error })
      return null
    }
    return data as MessageNode
  }

  // ノードIDで message_nodes を1件取得。次ノードへの遷移やスケジューラ配信で利用。
  async getNodeById(id: string): Promise<MessageNode | null> {
    const { data, error } = await this.client
      .from("message_nodes")
      .select("*")
      .eq("id", id)
      .maybeSingle()
    if (error) {
      console.error({ reason: "StoryDAO.getNodeById", error })
      return null
    }
    if (!data) return null
    return data as MessageNode
  }
}

export class FlexTemplateDAO {
  constructor(private client: SupabaseClient) {}

  // flex_template を ID で取得。ノードに紐づくテンプレート差し替え用。
  async findById(id: string): Promise<FlexTemplate | null> {
    const { data, error } = await this.client
      .from("flex_templates")
      .select("*")
      .eq("id", id)
      .single()
    if (error) {
      console.error({ reason: "FlexTemplateDAO.findById", error })
      return null
    }
    return data as FlexTemplate
  }

  // テンプレートを name で取得。特定のテンプレ利用時の参照に使う。
  async findByName(name: string): Promise<FlexTemplate | null> {
    const { data, error } = await this.client
      .from("flex_templates")
      .select("*")
      .eq("name", name)
      .single()
    if (error) {
      console.error({ reason: "FlexTemplateDAO.findByName", error })
      return null
    }
    return data as FlexTemplate
  }
}

// ユーザーごとのストーリーフロー進行状況を管理するDAO
export class UserFlowDAO {
  constructor(private client: SupabaseClient) {}

  // customer×story で1件 upsert。初回ストーリー開始や再開時に利用。
  async upsertFlow(
    customerId: string,
    storyId: string,
    currentNodeId: string,
    status: "in_progress" | "completed",
  ): Promise<void> {
    const { error } = await this.client
      .from("user_flows")
      .upsert(
        {
          customer_id: customerId,
          story_id: storyId,
          current_node_id: currentNodeId,
          status,
          next_scheduled_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "customer_id,story_id" },
      )

    if (error) console.error({ reason: "UserFlowDAO.upsertFlow", error })
  }

  // フローを completed にし、スケジュールをクリア。全ノード配信完了時に利用。
  async completeFlow(customerId: string, storyId: string): Promise<void> {
    const { error } = await this.client
      .from("user_flows")
      .update({
        status: "completed",
        next_scheduled_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("customer_id", customerId)
      .eq("story_id", storyId)
    if (error) console.error({ reason: "UserFlowDAO.completeFlow", error })
  }

  // 次回配信予定のみを更新。配信直後に「4日後20時」をセットするなどで利用。
  async updateSchedule(
    customerId: string,
    storyId: string,
    nextScheduledAt: string | null,
  ): Promise<void> {
    const { error } = await this.client
      .from("user_flows")
      .update({
        next_scheduled_at: nextScheduledAt,
        updated_at: new Date().toISOString(),
      })
      .eq("customer_id", customerId)
      .eq("story_id", storyId)
    if (error) console.error({ reason: "UserFlowDAO.updateSchedule", error })
  }

  // flowId で現在ノード・次配信日時・ステータスをまとめて更新。スケジューラ配信時などに利用。
  async updateCurrentNodeAndSchedule(
    flowId: string,
    nextNodeId: string | null,
    nextScheduledAt: string | null,
    status: "in_progress" | "completed",
  ) {
    const { error } = await this.client
      .from("user_flows")
      .update({
        current_node_id: nextNodeId,
        next_scheduled_at: nextScheduledAt,
        status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", flowId)
    if (error) {
      console.error({ reason: "UserFlowDAO.updateCurrentNodeAndSchedule", error })
    }
  }

  // customer_id と story_id で現在ノード・スケジュール・ステータスを更新。
  // アンケート完了後に次ノードへ進めるときに利用。
  async updateFlowByCustomerAndStory(
    customerId: string,
    storyId: string,
    nextNodeId: string | null,
    nextScheduledAt: string | null,
    status: "in_progress" | "completed",
  ) {
    const { error } = await this.client
      .from("user_flows")
      .update({
        current_node_id: nextNodeId,
        next_scheduled_at: nextScheduledAt,
        status,
        updated_at: new Date().toISOString(),
      })
      .eq("customer_id", customerId)
      .eq("story_id", storyId)
    if (error) {
      console.error({ reason: "UserFlowDAO.updateFlowByCustomerAndStory", error })
    }
  }

  // next_scheduled_at が now 以前で、かつ opt_in で in_progress なフローを取得。
  // スケジューラで配信対象を絞るために利用。
  async findDueFlows(nowIso: string) {
    const { data, error } = await this.client
      .from("user_flows")
      .select(
        `
        id,
        customer_id,
        story_id,
        current_node_id,
        next_scheduled_at,
        status,
        customers!inner(line_user_id,opt_in),
        message_nodes!inner(id,next_node_id,flex_template_id,title,body_text,image_url)
      `,
      )
      .lte("next_scheduled_at", nowIso)
      .eq("status", "in_progress")
      .eq("customers.opt_in", true)

    if (error) {
      console.error({ reason: "UserFlowDAO.findDueFlows", error })
      return []
    }
    return data ?? []
  }
}

// 配信ログ（story_targets）を扱うDAO
export class StoryTargetDAO {
  constructor(private client: SupabaseClient) {}

  async logSent(
    nodeId: string,
    customerId: string,
    status: "sent" | "pending" | "error",
    errorReason?: string | null,
  ): Promise<void> {
    const { error } = await this.client.from("story_targets").insert({
      node_id: nodeId,
      customer_id: customerId,
      status,
      sent_at: status === "sent" ? new Date().toISOString() : null,
      error_reason: errorReason ?? null,
    })
    if (error) console.error({ reason: "StoryTargetDAO.logSent", error })
  }
}

// アンケート（surveys/sessions/answers）関連 DAO
export class SurveyDAO {
  constructor(private client: SupabaseClient) {}

  // message_nodes.node_id からアンケートを特定。ノードに紐づくアンケート開始時に利用。
  async findByNodeId(nodeId: string): Promise<Survey | null> {
    const { data, error } = await this.client
      .from("surveys")
      .select("*")
      .eq("node_id", nodeId)
      .single()
    if (error) {
      console.error({ reason: "SurveyDAO.findByNodeId", error })
      return null
    }
    return data as Survey
  }

  // survey_id でアンケートを取得。story_id を辿る用途にも使う。
  async findById(id: string): Promise<Survey | null> {
    const { data, error } = await this.client.from("surveys").select("*").eq(
      "id",
      id,
    ).single()
    if (error) {
      console.error({ reason: "SurveyDAO.findById", error })
      return null
    }
    return data as Survey
  }

  // survey_id から story_id を取得。フロー完了更新時などに利用。
  async getStoryIdBySurveyId(surveyId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("surveys")
      .select("id, node_id, message_nodes!inner(id,story_id)")
      .eq("id", surveyId)
      .maybeSingle()

    if (error) {
      console.error({ reason: "SurveyDAO.getStoryIdBySurveyId", error })
      return null
    }
    if (!data) return null
    return (data as any)?.message_nodes?.story_id ?? null
  }

  // order_index に対応する質問を取得。次質問の取得や free_text 判定に利用。
  async getQuestionByOrder(
    surveyId: string,
    orderIndex: number,
  ): Promise<SurveyQuestion | null> {
    const { data, error } = await this.client
      .from("survey_questions")
      .select("*")
      .eq("survey_id", surveyId)
      .eq("order_index", orderIndex)
      .maybeSingle()
    if (error) {
      console.error({ reason: "SurveyDAO.getQuestionByOrder", error })
      return null
    }
    if (!data) return null
    return data as SurveyQuestion
  }

  // アンケートの質問リストを順序付きで取得。全体確認・デバッグ用途。
  async listQuestions(surveyId: string): Promise<SurveyQuestion[]> {
    const { data, error } = await this.client
      .from("survey_questions")
      .select("*")
      .eq("survey_id", surveyId)
      .order("order_index", { ascending: true })
    if (error) {
      console.error({ reason: "SurveyDAO.listQuestions", error })
      return []
    }
    return (data ?? []) as SurveyQuestion[]
  }

  // question_id で質問を取得。postback からの逆引きに利用。
  async getQuestionById(id: string): Promise<SurveyQuestion | null> {
    const { data, error } = await this.client
      .from("survey_questions")
      .select("*")
      .eq("id", id)
      .maybeSingle()
    if (error) {
      console.error({ reason: "SurveyDAO.getQuestionById", error })
      return null
    }
    if (!data) return null
    return data as SurveyQuestion
  }

  // 質問に紐づく選択肢を order_index 順で取得。プレースホルダ差し込み用。
  async getOptions(questionId: string): Promise<SurveyOption[]> {
    const { data, error } = await this.client
      .from("survey_options")
      .select("*")
      .eq("question_id", questionId)
      .order("order_index", { ascending: true })
    if (error) {
      console.error({ reason: "SurveyDAO.getOptions", error })
      return []
    }
    return (data ?? []) as SurveyOption[]
  }

  // survey_id × customer_id でセッションを取得。現在の進行状態を参照する。
  async getSession(
    surveyId: string,
    customerId: string,
  ): Promise<SurveySession | null> {
    const { data, error } = await this.client
      .from("survey_sessions")
      .select("*")
      .eq("survey_id", surveyId)
      .eq("customer_id", customerId)
      .maybeSingle()
    if (error) {
      console.error({ reason: "SurveyDAO.getSession", error })
      return null
    }
    if (!data) return null
    return data as SurveySession
  }

  // in_progress / awaiting_text のセッションを最新更新順で取得。free_text 待ち判定などに利用。
  async findActiveSession(customerId: string): Promise<SurveySession | null> {
    const { data, error } = await this.client
      .from("survey_sessions")
      .select("*")
      .eq("customer_id", customerId)
      .in("status", ["in_progress", "awaiting_text"])
      .order("last_interaction_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) {
      console.error({ reason: "SurveyDAO.findActiveSession", error })
      return null
    }
    return data as SurveySession
  }

  // セッションを upsert（作成/更新）し、current_order_index と status を反映。
  async upsertSession(
    surveyId: string,
    customerId: string,
    status: string,
    currentOrderIndex: number,
  ): Promise<SurveySession | null> {
    const { data, error } = await this.client
      .from("survey_sessions")
      .upsert(
        {
          survey_id: surveyId,
          customer_id: customerId,
          status,
          current_order_index: currentOrderIndex,
          last_interaction_at: new Date().toISOString(),
        },
        { onConflict: "survey_id,customer_id" },
      )
      .select()
      .single()

    if (error) {
      console.error({ reason: "SurveyDAO.upsertSession", error })
      return null
    }
    return data as SurveySession
  }

  // セッションの現在の order_index と status を更新。回答保存後に進行度を進める。
  async updateSessionProgress(
    sessionId: string,
    currentOrderIndex: number,
    status: string,
  ): Promise<void> {
    const { error } = await this.client
      .from("survey_sessions")
      .update({
        current_order_index: currentOrderIndex,
        status,
        last_interaction_at: new Date().toISOString(),
      })
      .eq("id", sessionId)
    if (error) {
      console.error({ reason: "SurveyDAO.updateSessionProgress", error })
    }
  }

  // セッションの status のみ更新。記述式開始など簡易状態変更に利用。
  async updateSessionStatus(sessionId: string, status: string): Promise<void> {
    const { error } = await this.client
      .from("survey_sessions")
      .update({
        status,
        last_interaction_at: new Date().toISOString(),
      })
      .eq("id", sessionId)
    if (error) console.error({ reason: "SurveyDAO.updateSessionStatus", error })
  }

  // 既存の回答ヘッダを取得。無い場合は null を返す。
  async findResponse(
    surveyId: string,
    customerId: string,
  ): Promise<SurveyResponse | null> {
    const { data, error } = await this.client
      .from("survey_responses")
      .select("*")
      .eq("survey_id", surveyId)
      .eq("customer_id", customerId)
      .maybeSingle()
    if (error) {
      console.error({ reason: "SurveyDAO.findResponse", error })
      return null
    }
    if (!data) return null
    return data as SurveyResponse
  }

  // 回答ヘッダを新規作成。既存チェックは行わない。
  async createResponse(
    surveyId: string,
    customerId: string,
  ): Promise<SurveyResponse | null> {
    const { data, error } = await this.client
      .from("survey_responses")
      .insert({
        survey_id: surveyId,
        customer_id: customerId,
        submitted_at: null,
      })
      .select()
      .single()
    if (error) {
      console.error({ reason: "SurveyDAO.createResponse", error })
      return null
    }
    return data as SurveyResponse
  }

  // 回答ヘッダを取得し、無ければ作成。回答保存前に必ず呼ぶ。
  async upsertResponse(
    surveyId: string,
    customerId: string,
  ): Promise<SurveyResponse | null> {
    const existing = await this.findResponse(surveyId, customerId)
    if (existing) return existing
    return await this.createResponse(surveyId, customerId)
  }

  // 回答ヘッダに submitted_at をセットし、完了を記録。
  async markResponseSubmitted(responseId: string): Promise<void> {
    const { error } = await this.client
      .from("survey_responses")
      .update({ submitted_at: new Date().toISOString() })
      .eq("id", responseId)
    if (error) {
      console.error({ reason: "SurveyDAO.markResponseSubmitted", error })
    }
  }

  // 問題単位の回答を保存 or 更新（option_id / text_answer のいずれか）。
  async saveOrUpdateAnswer(
    responseId: string,
    questionId: string,
    payload: { optionId?: string; textAnswer?: string | null },
  ): Promise<void> {
    const { data, error } = await this.client
      .from("survey_answers")
      .select("id")
      .eq("response_id", responseId)
      .eq("question_id", questionId)
      .maybeSingle()

    if (error) {
      console.error({ reason: "SurveyDAO.saveOrUpdateAnswer.select", error })
      return
    }

    if (data?.id) {
      const { error: updateError } = await this.client
        .from("survey_answers")
        .update({
          option_id: payload.optionId ?? null,
          text_answer: payload.textAnswer ?? null,
        })
        .eq("id", data.id)
      if (updateError) {
        console.error({ reason: "SurveyDAO.saveOrUpdateAnswer.update", updateError })
      }
      return
    }

    const { error: insertError } = await this.client.from("survey_answers")
      .insert({
        response_id: responseId,
        question_id: questionId,
        option_id: payload.optionId ?? null,
        text_answer: payload.textAnswer ?? null,
      })
    if (insertError) {
      console.error({ reason: "SurveyDAO.saveOrUpdateAnswer.insert", insertError })
    }
  }

  // 指定アンケート・顧客の回答一覧を、質問の order_index 付きで取得。プロフィール反映時に利用。
  async getAnswersBySurveyAndCustomer(
    surveyId: string,
    customerId: string,
  ): Promise<AnswerRecord[]> {
    const { data, error } = await this.client
      .from("survey_answers")
      .select(
        `
        id,
        response_id,
        option_id,
        text_answer,
        survey_responses!inner (id, survey_id, customer_id),
        survey_questions!inner (id, order_index)
      `,
      )
      .eq("survey_responses.survey_id", surveyId)
      .eq("survey_responses.customer_id", customerId)

    if (error) {
      console.error({ reason: "SurveyDAO.getAnswersBySurveyAndCustomer", error })
      return []
    }

    return (data ?? []).map((row: any) => ({
      questionId: row.survey_questions.id,
      orderIndex: row.survey_questions.order_index,
      optionId: row.option_id ?? undefined,
      textAnswer: row.text_answer ?? undefined,
      value: row.text_answer ?? undefined,
    }))
  }
}

// マスタ系テーブル取得＋自由入力大学の登録
// マスタ系テーブル取得＋自由入力大学の登録
export class MasterDataDAO {
  constructor(private client: SupabaseClient) {}

  // 学年マスタを order_index 順に取得（最大 limit 件）。質問 Q1 の選択肢生成に利用。
  async getGrades(limit = 12) {
    const { data, error } = await this.client
      .from("grades")
      .select("id, display_name")
      .order("order_index", { ascending: true })
      .limit(limit)
    if (error) {
      console.error({ reason: "MasterDataDAO.getGrades", error })
      return []
    }
    return data ?? []
  }

  // 専攻マスタを order_index 順に取得。質問 Q2 の選択肢生成に利用。
  async getMajors(limit = 12) {
    const { data, error } = await this.client
      .from("majors")
      .select("id, display_name")
      .order("order_index", { ascending: true })
      .limit(limit)
    if (error) {
      console.error({ reason: "MasterDataDAO.getMajors", error })
      return []
    }
    return data ?? []
  }

  // 大学マスタを order_index → name 順に取得。質問 Q3 の選択肢生成に利用。
  async getUniversities(limit = 12) {
    const { data, error } = await this.client
      .from("universities")
      .select("id, name")
      .order("order_index", { ascending: true })
      .order("name", { ascending: true })
      .limit(limit)
    if (error) {
      console.error({ reason: "MasterDataDAO.getUniversities", error })
      return []
    }
    return data ?? []
  }

  // 自由記述の大学名を既存重複チェック後、無ければ order_index を連番で採番して登録。
  // Q4 の自由入力回答を customers.university_id に反映するために利用。
  async upsertFreeTextUniversity(name: string): Promise<string | null> {
    if (!name) return null
    // Try to find existing by exact name
    const { data: existing, error: findError } = await this.client
      .from("universities")
      .select("id")
      .eq("name", name)
      .maybeSingle()
    if (findError) {
      console.error({ reason: "MasterDataDAO.upsertFreeTextUniversity.find", findError })
    }
    if (existing?.id) return existing.id

    // Determine next order_index (max + 1)
    const { data: maxRow, error: maxError } = await this.client
      .from("universities")
      .select("order_index")
      .order("order_index", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (maxError) {
      console.error({ reason: "MasterDataDAO.upsertFreeTextUniversity.max", maxError })
    }
    const nextOrderIndex = (maxRow?.order_index ?? 0) + 1

    const { data, error } = await this.client
      .from("universities")
      .insert({
        name,
        order_index: nextOrderIndex,
      })
      .select("id")
      .single()
    if (error) {
      console.error({ reason: "MasterDataDAO.upsertFreeTextUniversity.insert", error })
      return null
    }
    return data?.id ?? null
  }

  // 五十音グループで都道府県を取得。質問 Q6 の選択肢生成に利用。
  async getPrefecturesByGroup(
    kanaGroup: string,
    limit = 12,
  ) {
    const { data, error } = await this.client
      .from("prefectures")
      .select("id, display_name")
      .eq("kana_group", kanaGroup)
      .order("order_index", { ascending: true })
      .limit(limit)
    if (error) {
      console.error({ reason: "MasterDataDAO.getPrefecturesByGroup", error })
      return []
    }
    return data ?? []
  }
}
