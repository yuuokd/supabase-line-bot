// LINE Webhook エントリーポイント。署名検証→イベントループ→各ハンドラに委譲する。
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { supabaseClient } from "./supabaseClient.ts"
import {
  CustomerDAO,
  FlexTemplateDAO,
  MasterDataDAO,
  StoryDAO,
  StoryTargetDAO,
  SurveyDAO,
  UserFlowDAO,
} from "./dao.ts"
import { LineClient } from "./lineClient.ts"
import { FlexMessageBuilder } from "./flexBuilder.ts"
import { WebhookService } from "./services.ts"
import { LineEvent } from "./types.ts"

const supabase = supabaseClient()
const lineClient = new LineClient(
  Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "",
  Deno.env.get("LINE_CHANNEL_SECRET") ?? null,
)

const service = new WebhookService({
  customerDao: new CustomerDAO(supabase),
  storyDao: new StoryDAO(supabase),
  flexTemplateDao: new FlexTemplateDAO(supabase),
  userFlowDao: new UserFlowDAO(supabase),
  storyTargetDao: new StoryTargetDAO(supabase),
  surveyDao: new SurveyDAO(supabase),
  masterDao: new MasterDataDAO(supabase),
  lineClient,
  flexBuilder: new FlexMessageBuilder(),
})

console.log("LINE webhook function booted")

serve(async (req) => {
  try {
    // 署名検証は生ボディ文字列で行う必要がある
    const bodyText = await req.text()
    const signature = req.headers.get("x-line-signature")
    const validSignature = await lineClient.validateSignature(
      bodyText,
      signature,
    )
    if (!validSignature) {
      console.error("LINE signature verification failed")
      return new Response("invalid signature", { status: 401 })
    }

    // イベント配列をパースしてすべてのイベントを順次処理
    const body = JSON.parse(bodyText)
    const events: LineEvent[] = body?.events ?? []
    for (const event of events) {
      await service.handleEvent(event)
    }

    return new Response(
      JSON.stringify({ status: "ok" }),
      { headers: { "Content-Type": "application/json" } },
    )
  } catch (error) {
    console.error("Unhandled error on webhook", error)
    return new Response("Internal Server Error", { status: 500 })
  }
})
