import "jsr:@supabase/functions-js/edge-runtime.d.ts"
// line-bot-scheduler: next_scheduled_at が過ぎたフローをキックするだけの定期配信用 Edge Function
// 想定利用:
// - Cron で定期呼び出しし、user_flows の next_scheduled_at <= now かつ opt_in=true のレコードを配信
// - 配信対象は line-bot 側と同じロジックで Flex を構築し、次ノードへ進める
import { supabaseClient } from "../line-bot/supabaseClient.ts"
import {
  CustomerDAO,
  FlexTemplateDAO,
  StoryDAO,
  StoryTargetDAO,
  SurveyDAO,
  UserFlowDAO,
} from "../line-bot/dao.ts"
import { FlexMessageBuilder } from "../line-bot/flexBuilder.ts"
import { LineClient } from "../line-bot/lineClient.ts"

const supabase = supabaseClient()
const lineClient = new LineClient(
  Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "",
  Deno.env.get("LINE_CHANNEL_SECRET") ?? null,
)

const flowDao = new UserFlowDAO(supabase)
const storyDao = new StoryDAO(supabase)
const flexTemplateDao = new FlexTemplateDAO(supabase)
const storyTargetDao = new StoryTargetDAO(supabase)
const surveyDao = new SurveyDAO(supabase)
const customerDao = new CustomerDAO(supabase)
const flexBuilder = new FlexMessageBuilder()

// next_scheduled_at が期限を過ぎているフローを取得し、次ノードを push する。
// 流れ: 期限切れ取得 → 次ノード無しなら completed → あれば Flex 生成して配信 → story_targets ログ → current_node と schedule を更新
async function processDueFlows() {
  const nowIso = new Date().toISOString()
  const dueFlows = await flowDao.findDueFlows(nowIso)
  let sent = 0
  let completed = 0

  for (const flow of dueFlows) {
    try {
      const nextNodeId = (flow.message_nodes as any)?.next_node_id
      if (!nextNodeId) {
        await flowDao.updateCurrentNodeAndSchedule(
          flow.id,
          null,
          null,
          "completed",
        )
        completed++
        continue
      }

      const nextNode = await storyDao.getNodeById(nextNodeId as string)
      if (!nextNode) continue

      const template = await flexTemplateDao.findById(
        (nextNode as any).flex_template_id,
      )
      if (!template) continue

      const survey = await surveyDao.findByNodeId((nextNode as any).id)
      let primaryData: Record<string, unknown> = {}
      if (survey) {
        const firstQuestion = await surveyDao.getQuestionByOrder(
          survey.id,
          1,
        )
        primaryData = firstQuestion
          ? {
            action: "start_survey",
            surveyId: survey.id,
            questionId: firstQuestion.id,
            orderIndex: firstQuestion.order_index,
          }
          : {}
      } else {
        primaryData = {
          action: "complete_flow",
          storyId: flow.story_id,
          nodeId: (nextNode as any).id,
        }
      }

      const message = flexBuilder.buildContentMessage(template, {
        title: (nextNode as any).title ?? "お知らせ",
        bodyText: (nextNode as any).body_text ?? "",
        imageUrl: (nextNode as any).image_url,
        primaryLabel: "確認",
        primaryDisplayText: "確認",
        primaryData,
        altText: (nextNode as any).title ?? "お知らせ",
      })

      const lineUserId = (flow.customers as any)?.line_user_id
      if (!lineUserId) continue
      await lineClient.push(lineUserId, [message])
      sent++
      await storyTargetDao.logSent((nextNode as any).id, flow.customer_id, "sent")

      await flowDao.updateCurrentNodeAndSchedule(
        flow.id,
        (nextNode as any).id,
        scheduleAfterDays(4).toISOString(),
        "in_progress",
      )
    } catch (error) {
      console.error({ reason: "scheduler.processDueFlows", error, flow })
    }
  }

  return { due: dueFlows.length, sent, completed }
}

function scheduleAfterDays(days: number): Date {
  const d = new Date()
  d.setDate(d.getDate() + days)
  d.setHours(0, 0, 0, 0) // 0:00 utc
  return d
}

Deno.serve(async () => {
  try {
    const result = await processDueFlows()
    return new Response(
      JSON.stringify({ status: "ok", ...result }),
      { headers: { "Content-Type": "application/json" } },
    )
  } catch (error) {
    console.error({ reason: "scheduler.serve", error })
    return new Response("Internal Server Error", { status: 500 })
  }
})
