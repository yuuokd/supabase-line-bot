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

export class StoryDAO {
  constructor(private client: SupabaseClient) {}

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

export class UserFlowDAO {
  constructor(private client: SupabaseClient) {}

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
        customers!inner(line_user_id),
        message_nodes!inner(id,next_node_id,flex_template_id,title,body_text,image_url)
      `,
      )
      .lte("next_scheduled_at", nowIso)
      .eq("status", "in_progress")

    if (error) {
      console.error({ reason: "UserFlowDAO.findDueFlows", error })
      return []
    }
    return data ?? []
  }
}

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

export class SurveyDAO {
  constructor(private client: SupabaseClient) {}

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

  async upsertResponse(
    surveyId: string,
    customerId: string,
  ): Promise<SurveyResponse | null> {
    const existing = await this.findResponse(surveyId, customerId)
    if (existing) return existing
    return await this.createResponse(surveyId, customerId)
  }

  async markResponseSubmitted(responseId: string): Promise<void> {
    const { error } = await this.client
      .from("survey_responses")
      .update({ submitted_at: new Date().toISOString() })
      .eq("id", responseId)
    if (error) {
      console.error({ reason: "SurveyDAO.markResponseSubmitted", error })
    }
  }

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

export class MasterDataDAO {
  constructor(private client: SupabaseClient) {}

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
