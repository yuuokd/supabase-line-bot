import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { supabaseClient } from "./supabaseClient.ts"
import {
  CustomerDAO,
  FlexTemplateDAO,
  StoryDAO,
  StoryTargetDAO,
  SurveyDAO,
  UserFlowDAO,
} from "./dao.ts"
import { FlexMessageBuilder } from "./flexBuilder.ts"
import { LineClient } from "./lineClient.ts"

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

async function processDueFlows() {
  const nowIso = new Date().toISOString()
  const dueFlows = await flowDao.findDueFlows(nowIso)
  let sent = 0
  let completed = 0

  for (const flow of dueFlows) {
    try {
      const currentNode: any = flow.message_nodes
      const nextNodeId = currentNode?.next_node_id
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

      const message = flexBuilder.buildContentMessage(template, {
        title: (nextNode as any).title ?? "お知らせ",
        bodyText: (nextNode as any).body_text ?? "",
        imageUrl: (nextNode as any).image_url,
        primaryLabel: "確認",
        primaryDisplayText: "確認",
        primaryData: {},
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
        addDays(1).toISOString(),
        "in_progress",
      )
    } catch (error) {
      console.error({ reason: "scheduler.processDueFlows", error, flow })
    }
  }

  return { due: dueFlows.length, sent, completed }
}

function addDays(days: number): Date {
  const now = new Date()
  now.setDate(now.getDate() + days)
  return now
}

serve(async (req) => {
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
