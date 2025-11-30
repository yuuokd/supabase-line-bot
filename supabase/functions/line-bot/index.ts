// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// -----------------------------
// Supabase client (service_role)
// -----------------------------
const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
)

// -----------------------------
// LINE client helpers
// -----------------------------
const LINE_API_BASE = "https://api.line.me/v2/bot"
const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? ""
const LINE_CHANNEL_SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? ""

const lineHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
}

const replyMessage = async (replyToken: string, messages: any[]) => {
  await fetch(`${LINE_API_BASE}/message/reply`, {
    method: "POST",
    headers: lineHeaders,
    body: JSON.stringify({ replyToken, messages }),
  })
}

const pushMessage = async (to: string, messages: any[]) => {
  await fetch(`${LINE_API_BASE}/message/push`, {
    method: "POST",
    headers: lineHeaders,
    body: JSON.stringify({ to, messages }),
  })
}

const verifySignature = async (body: string, signature: string | null) => {
  if (!signature) return false
  const encoder = new TextEncoder()
  const keyData = encoder.encode(LINE_CHANNEL_SECRET)
  const bodyData = encoder.encode(body)

  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signed = await crypto.subtle.sign("HMAC", key, bodyData)
  const digest = btoa(String.fromCharCode(...new Uint8Array(signed)))
  return digest === signature
}

// -----------------------------
// Flex template renderer
// -----------------------------
const renderTemplate = (
  layout: Record<string, unknown>,
  replacements: Record<string, string>,
) => {
  const replaceValue = (value: any): any => {
    if (Array.isArray(value)) return value.map((v) => replaceValue(v))
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {}
      Object.entries(value).forEach(([k, v]) => {
        out[k] = replaceValue(v)
      })
      return out
    }
    if (typeof value === "string") {
      const exact = value.match(/^\{([A-Z0-9_]+)\}$/)
      if (exact) {
        const k = exact[1]
        return k in replacements ? replacements[k] : value
      }
      return value.replace(/\{([A-Z0-9_]+)\}/g, (_, k) =>
        replacements[k] ?? ""
      )
    }
    return value
  }
  return replaceValue(layout)
}

const fetchTemplateByName = async (name: string) => {
  const { data, error } = await supabase
    .from("flex_templates")
    .select("layout_json")
    .eq("name", name)
    .maybeSingle()
  if (error) {
    console.error({ caused: "fetchTemplateByName", error, name })
    return null
  }
  return (data as any)?.layout_json ?? null
}

// -----------------------------
// Story helpers
// -----------------------------
const PROFILE_STORY_TITLE = "初回プロフィール登録ストーリー"

const upsertCustomer = async (lineUserId: string, displayName?: string) => {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from("customers")
    .upsert({
      line_user_id: lineUserId,
      line_display_name: displayName ?? null,
      opt_in: true,
      is_blocked: false,
      blocked_at: null,
      updated_at: now,
    }, { onConflict: "line_user_id" })
    .select("id")
    .maybeSingle()
  if (error) {
    console.error({ caused: "upsertCustomer", error })
    return null
  }
  return (data as any)?.id ?? null
}

const getProfileStoryEntry = async () => {
  const { data: story, error: storyErr } = await supabase
    .from("stories")
    .select("id")
    .eq("title", PROFILE_STORY_TITLE)
    .maybeSingle()
  if (storyErr || !story) {
    console.error({ caused: "getProfileStoryEntry.story", storyErr })
    return null
  }

  const { data: node, error: nodeErr } = await supabase
    .from("message_nodes")
    .select("id, title, body_text, flex_templates(layout_json)")
    .eq("story_id", (story as any).id)
    .is("prev_node_id", null)
    .maybeSingle()
  if (nodeErr || !node) {
    console.error({ caused: "getProfileStoryEntry.node", nodeErr })
    return null
  }

  return { storyId: (story as any).id, node }
}

const upsertUserFlow = async (customerId: string, storyId: string, nodeId: string) => {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from("user_flows")
    .upsert({
      customer_id: customerId,
      story_id: storyId,
      current_node_id: nodeId,
      status: "in_progress",
      next_scheduled_at: null,
      updated_at: now,
    }, { onConflict: "customer_id,story_id" })
  if (error) console.error({ caused: "upsertUserFlow", error })
}

const insertStoryTarget = async (nodeId: string, customerId: string) => {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from("story_targets")
    .insert({
      node_id: nodeId,
      customer_id: customerId,
      status: "sent",
      sent_at: now,
    })
  if (error) console.error({ caused: "insertStoryTarget", error })
}

const buildEntryFlex = (node: any) => {
  const template = node.flex_templates?.layout_json
  if (!template) return null
  const replacements = {
    TITLE: node.title ?? "プロフィール登録のお願い",
    BODY_TEXT: node.body_text ??
      "あなたに合った情報をお届けするため、学年・専攻・大学・居住地を教えてください。",
    PRIMARY_LABEL: "登録する",
    PRIMARY_DISPLAY: "登録する",
    PRIMARY_DATA: JSON.stringify({
      action: "start_profile_story",
      story_id: node.story_id,
      node_id: node.id,
    }),
  }
  return {
    type: "flex",
    altText: replacements.TITLE,
    contents: renderTemplate(template, replacements),
  }
}

// -----------------------------
// Survey helpers
// -----------------------------
type QuestionPayload = {
  question: any
  options: any[]
}

const ensureSurveySession = async (surveyId: string, customerId: string) => {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from("survey_sessions")
    .upsert({
      survey_id: surveyId,
      customer_id: customerId,
      status: "in_progress",
      current_order_index: 0,
      last_interaction_at: now,
    }, { onConflict: "survey_id,customer_id" })
    .select("id,current_order_index,status")
    .maybeSingle()

  if (error) {
    console.error({ caused: "ensureSurveySession", error })
    return null
  }
  return data as any
}

const fetchQuestionByOrder = async (surveyId: string, orderIndex: number) => {
  const { data, error } = await supabase
    .from("survey_questions")
    .select("id,question_text,question_type,order_index,flex_template_id")
    .eq("survey_id", surveyId)
    .eq("order_index", orderIndex)
    .maybeSingle()
  if (error) {
    console.error({ caused: "fetchQuestionByOrder", error, surveyId, orderIndex })
    return null
  }
  return data as any
}

const fetchNextQuestion = async (surveyId: string, currentOrderIndex: number) => {
  const { data, error } = await supabase
    .from("survey_questions")
    .select("id,question_text,question_type,order_index,flex_template_id")
    .eq("survey_id", surveyId)
    .gt("order_index", currentOrderIndex)
    .order("order_index", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error({ caused: "fetchNextQuestion", error })
    return null
  }
  return data as any
}

const fetchOptionsForQuestion = async (question: any, lastPrefGroup?: string | null) => {
  // Dynamic options based on order_index
  switch (question.order_index) {
    case 1: { // grades
      const { data, error } = await supabase
        .from("grades")
        .select("id,display_name")
        .order("order_index", { ascending: true })
        .limit(12)
      if (error) console.error({ caused: "fetchOptions grades", error })
      return data ?? []
    }
    case 2: { // majors
      const { data, error } = await supabase
        .from("majors")
        .select("id,display_name")
        .order("order_index", { ascending: true })
        .limit(12)
      if (error) console.error({ caused: "fetchOptions majors", error })
      return data ?? []
    }
    case 3: { // universities (limited to 12)
      const { data, error } = await supabase
        .from("universities")
        .select("id,name")
        .order("name", { ascending: true })
        .limit(12) // TODO: paging for more
      if (error) console.error({ caused: "fetchOptions universities", error })
      return data ?? []
    }
    case 5: { // pref group (already in survey_options)
      const { data, error } = await supabase
        .from("survey_options")
        .select("id,label,value,order_index")
        .eq("question_id", question.id)
        .order("order_index", { ascending: true })
      if (error) console.error({ caused: "fetchOptions pref_group", error })
      return data ?? []
    }
    case 6: { // prefectures filtered by kana_group
      const group = lastPrefGroup ?? "あ行"
      const { data, error } = await supabase
        .from("prefectures")
        .select("id,display_name,order_index")
        .eq("kana_group", group)
        .order("order_index", { ascending: true })
        .limit(12)
      if (error) console.error({ caused: "fetchOptions prefectures", error })
      return data ?? []
    }
    default: {
      const { data, error } = await supabase
        .from("survey_options")
        .select("id,label,value,order_index")
        .eq("question_id", question.id)
        .order("order_index", { ascending: true })
      if (error) console.error({ caused: "fetchOptions default", error })
      return data ?? []
    }
  }
}

const buildQuestionMessage = async (
  surveyId: string,
  question: any,
  options: any[],
  extra: { prevPrefGroup?: string | null },
) => {
  const template = await fetchTemplateById(question.flex_template_id)
  if (!template) return null

  // Fill placeholders
  const replacements: Record<string, string> = {
    QUESTION_TITLE: question.question_text ?? "",
    QUESTION_TEXT: question.question_text ?? "",
  }

  options.slice(0, 12).forEach((opt, idx) => {
    const i = idx + 1
    replacements[`OPTION${i}_LABEL`] = opt.display_name ?? opt.label ?? `選択${i}`
    replacements[`OPTION${i}_DISPLAY`] = opt.display_name ?? opt.label ?? `選択${i}`
    replacements[`OPTION${i}_DATA`] = JSON.stringify({
      action: "answer_survey",
      survey_id: surveyId,
      question_id: question.id,
      option_id: opt.id,
      option_value: opt.id ?? opt.value,
      pref_group: extra.prevPrefGroup ?? null,
    })
  })

  // free text start button
  if (question.order_index === 4) {
    replacements["START_LABEL"] = "入力する"
    replacements["START_DISPLAY"] = "入力する"
    replacements["START_DATA"] = JSON.stringify({
      action: "start_free_text",
      survey_id: surveyId,
      question_id: question.id,
    })
  }

  return {
    type: "flex",
    altText: question.question_text ?? "質問があります",
    contents: renderTemplate(template, replacements),
  }
}

const fetchTemplateById = async (id: string) => {
  const { data, error } = await supabase
    .from("flex_templates")
    .select("layout_json")
    .eq("id", id)
    .maybeSingle()
  if (error) {
    console.error({ caused: "fetchTemplateById", error })
    return null
  }
  return (data as any)?.layout_json ?? null
}

const upsertSurveyResponse = async (surveyId: string, customerId: string) => {
  const { data, error } = await supabase
    .from("survey_responses")
    .upsert({
      survey_id: surveyId,
      customer_id: customerId,
      submitted_at: new Date().toISOString(),
    }, { onConflict: "survey_id,customer_id" })
    .select("id")
    .maybeSingle()
  if (error) {
    console.error({ caused: "upsertSurveyResponse", error })
    return null
  }
  return (data as any)?.id ?? null
}

const insertSurveyAnswer = async (responseId: string, payload: {
  questionId: string
  optionId?: string | null
  textAnswer?: string | null
}) => {
  const { error } = await supabase
    .from("survey_answers")
    .insert({
      response_id: responseId,
      question_id: payload.questionId,
      option_id: payload.optionId ?? null,
      text_answer: payload.textAnswer ?? null,
    })
  if (error) console.error({ caused: "insertSurveyAnswer", error, payload })
}

const updateCustomerProfileFromAnswer = async (
  customerId: string,
  questionOrder: number,
  value: string,
) => {
  const fields: Record<number, string> = {
    1: "grade_id",
    2: "major_id",
    6: "prefecture_id",
  }
  const field = fields[questionOrder]
  if (!field) return
  const { error } = await supabase
    .from("customers")
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq("id", customerId)
  if (error) console.error({ caused: "updateCustomerProfileFromAnswer", error, field, value })
}

// -----------------------------
// Main handler
// -----------------------------
serve(async (req) => {
  const url = new URL(req.url)
  if (url.pathname !== "/line-webhook") {
    return new Response("not found", { status: 404 })
  }

  const bodyText = await req.text()
  const signature = req.headers.get("x-line-signature")
  const valid = await verifySignature(bodyText, signature)
  if (!valid) {
    return new Response("invalid signature", { status: 401 })
  }

  const body = JSON.parse(bodyText)
  const events: any[] = body.events ?? []

  for (const event of events) {
    try {
      if (event.type === "follow") {
        const customerId = await upsertCustomer(event.source?.userId, event.source?.displayName)
        if (!customerId) continue
        const entry = await getProfileStoryEntry()
        if (!entry) continue
        await upsertUserFlow(customerId, entry.storyId, entry.node.id)
        const flex = buildEntryFlex(entry.node)
        if (flex) {
          await pushMessage(event.source.userId, [flex])
          await insertStoryTarget(entry.node.id, customerId)
        }
      } else if (event.type === "unfollow") {
        const now = new Date().toISOString()
        await supabase.from("customers").update({
          is_blocked: true,
          blocked_at: now,
          updated_at: now,
        }).eq("line_user_id", event.source?.userId)
      } else if (event.type === "postback") {
        await handlePostback(event)
      } else if (event.type === "message" && event.message?.type === "text") {
        await handleFreeTextAnswer(event)
      }
    } catch (error) {
      console.error({ caused: "event_handler", error, event })
    }
  }

  return new Response(JSON.stringify({ status: "ok" }), {
    headers: { "Content-Type": "application/json" },
  })
})

// -----------------------------
// Postback handler
// -----------------------------
const handlePostback = async (event: any) => {
  const data = JSON.parse(event.postback.data)
  const action = data.action
  const replyToken = event.replyToken
  if (action === "start_profile_story") {
    // fetch survey by node_id
    const { data: survey, error } = await supabase
      .from("surveys")
      .select("id")
      .eq("node_id", data.node_id)
      .maybeSingle()
    if (error || !survey) {
      console.error({ caused: "handlePostback.start_profile_story", error })
      await replyMessage(replyToken, [{ type: "text", text: "エラーが発生しました。" }])
      return
    }
    await startSurvey(event.source.userId, survey.id, replyToken)
    return
  }

  if (action === "answer_survey") {
    await handleAnswerSurvey(event, data)
    return
  }

  if (action === "start_free_text") {
    await markWaitingFreeText(event.source.userId, data.survey_id, data.question_id, replyToken)
    return
  }
}

const startSurvey = async (lineUserId: string, surveyId: string, replyToken: string) => {
  const customer = await supabase
    .from("customers")
    .select("id")
    .eq("line_user_id", lineUserId)
    .maybeSingle()
  if (customer.error || !customer.data) {
    await replyMessage(replyToken, [{ type: "text", text: "エラーが発生しました。" }])
    return
  }
  const customerId = (customer.data as any).id
  const session = await ensureSurveySession(surveyId, customerId)
  if (!session) {
    await replyMessage(replyToken, [{ type: "text", text: "エラーが発生しました。" }])
    return
  }
  const question = await fetchQuestionByOrder(surveyId, 1)
  if (!question) {
    await replyMessage(replyToken, [{ type: "text", text: "エラーが発生しました。" }])
    return
  }
  const options = await fetchOptionsForQuestion(question)
  const msg = await buildQuestionMessage(surveyId, question, options, { prevPrefGroup: null })
  if (msg) {
    await replyMessage(replyToken, [msg])
  }
}

const handleAnswerSurvey = async (event: any, data: any) => {
  const lineUserId = event.source.userId
  const replyToken = event.replyToken
  const { survey_id, question_id, option_id, option_value, pref_group } = data

  const customer = await supabase
    .from("customers")
    .select("id")
    .eq("line_user_id", lineUserId)
    .maybeSingle()
  if (customer.error || !customer.data) {
    await replyMessage(replyToken, [{ type: "text", text: "エラーが発生しました。" }])
    return
  }
  const customerId = (customer.data as any).id

  const session = await ensureSurveySession(survey_id, customerId)
  if (!session) {
    await replyMessage(replyToken, [{ type: "text", text: "エラーが発生しました。" }])
    return
  }

  // fetch current question
  const { data: question, error: qErr } = await supabase
    .from("survey_questions")
    .select("id,order_index,question_text,question_type")
    .eq("id", question_id)
    .maybeSingle()
  if (qErr || !question) {
    await replyMessage(replyToken, [{ type: "text", text: "エラーが発生しました。" }])
    return
  }

  const responseId = await upsertSurveyResponse(survey_id, customerId)
  if (!responseId) {
    await replyMessage(replyToken, [{ type: "text", text: "エラーが発生しました。" }])
    return
  }

  await insertSurveyAnswer(responseId, {
    questionId: question.id,
    optionId: option_id ?? null,
    textAnswer: null,
  })

  await updateCustomerProfileFromAnswer(customerId, question.order_index, option_value)

  // advance session
  const now = new Date().toISOString()
  await supabase
    .from("survey_sessions")
    .update({
      current_order_index: question.order_index,
      last_interaction_at: now,
      status: "in_progress",
    })
    .eq("survey_id", survey_id)
    .eq("customer_id", customerId)

  const nextQuestion = await fetchNextQuestion(survey_id, question.order_index)
  if (!nextQuestion) {
    await completeSurvey(customerId, survey_id)
    await replyMessage(replyToken, [{ type: "text", text: "ありがとうございます！プロフィール登録が完了しました。" }])
    return
  }

  let lastPrefGroup = pref_group ?? null
  if (question.order_index === 5) {
    lastPrefGroup = option_value
  }
  const options = await fetchOptionsForQuestion(nextQuestion, lastPrefGroup)
  const msg = await buildQuestionMessage(survey_id, nextQuestion, options, { prevPrefGroup: lastPrefGroup })
  if (msg) {
    await replyMessage(replyToken, [msg])
  }
}

const markWaitingFreeText = async (
  lineUserId: string,
  surveyId: string,
  questionId: string,
  replyToken: string,
) => {
  const customer = await supabase
    .from("customers")
    .select("id")
    .eq("line_user_id", lineUserId)
    .maybeSingle()
  if (customer.error || !customer.data) {
    await replyMessage(replyToken, [{ type: "text", text: "エラーが発生しました。" }])
    return
  }
  const customerId = (customer.data as any).id

  await ensureSurveySession(surveyId, customerId)
  await supabase
    .from("survey_sessions")
    .update({
      current_order_index: 4,
      status: "in_progress",
      last_interaction_at: new Date().toISOString(),
    })
    .eq("survey_id", surveyId)
    .eq("customer_id", customerId)

  await replyMessage(replyToken, [{
    type: "text",
    text: "大学名をテキストで入力してください。",
  }])
}

// -----------------------------
// Free text message handler
// -----------------------------
const handleFreeTextAnswer = async (event: any) => {
  const lineUserId = event.source.userId
  const text = event.message.text
  const replyToken = event.replyToken

  // find active free-text question (order_index = 4)
  const { data: session, error } = await supabase
    .from("survey_sessions")
    .select("survey_id,current_order_index,customer_id,status")
    .eq("customer_id", (await getCustomerId(lineUserId)))
    .eq("status", "in_progress")
    .maybeSingle()
  if (error || !session) return
  if (session.current_order_index !== 4) return

  // fetch question id with order_index 4
  const question = await fetchQuestionByOrder(session.survey_id, 4)
  if (!question) return

  const responseId = await upsertSurveyResponse(session.survey_id, session.customer_id)
  if (!responseId) return

  await insertSurveyAnswer(responseId, {
    questionId: question.id,
    textAnswer: text,
  })

  const now = new Date().toISOString()
  await supabase
    .from("survey_sessions")
    .update({
      current_order_index: 4,
      last_interaction_at: now,
    })
    .eq("survey_id", session.survey_id)
    .eq("customer_id", session.customer_id)

  const nextQuestion = await fetchNextQuestion(session.survey_id, 4)
  if (nextQuestion) {
    const options = await fetchOptionsForQuestion(nextQuestion)
    const msg = await buildQuestionMessage(session.survey_id, nextQuestion, options, { prevPrefGroup: null })
    if (msg) await replyMessage(replyToken, [msg])
  }
}

const getCustomerId = async (lineUserId: string) => {
  const { data, error } = await supabase
    .from("customers")
    .select("id")
    .eq("line_user_id", lineUserId)
    .maybeSingle()
  if (error) {
    console.error({ caused: "getCustomerId", error })
    return null
  }
  return (data as any)?.id ?? null
}

// -----------------------------
// Completion
// -----------------------------
const completeSurvey = async (customerId: string, surveyId: string) => {
  const now = new Date().toISOString()
  await supabase
    .from("survey_sessions")
    .update({ status: "completed", last_interaction_at: now })
    .eq("survey_id", surveyId)
    .eq("customer_id", customerId)

  await supabase
    .from("user_flows")
    .update({ status: "completed", updated_at: now })
    .eq("customer_id", customerId)
    .eq("story_id", await getStoryIdBySurvey(surveyId))
}

const getStoryIdBySurvey = async (surveyId: string) => {
  const { data, error } = await supabase
    .from("surveys")
    .select("message_nodes(story_id)")
    .eq("id", surveyId)
    .maybeSingle()
  if (error) {
    console.error({ caused: "getStoryIdBySurvey", error })
    return null
  }
  return (data as any)?.message_nodes?.story_id ?? null
}
