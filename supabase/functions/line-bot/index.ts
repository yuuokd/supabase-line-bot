// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { selectQuiz } from "./selectQuiz.ts"
import { supabaseClient } from './supabaseClient.ts'
import { Quiz } from "./quiz.ts"
import { confirmMessage } from './messages.ts'

serve(async (req) => {
  const { name, events } = await req.json()
  console.log(events)
  // if (events && events[0]?.type === "message") {
  //   // 文字列化したメッセージデータ
  //   let messages:any = [
  //     {
  //       "type": "text",
  //       "text": "Hello, user"
  //     },
  //     {
  //       "type": "text",
  //       "text": "May I help you?"
  //     }
  //   ]
  //   if (events[0].message.text === 'quiz') {
  //     messages = await selectQuiz(supabaseClient(req))
  //   }
  //   // MEMO:
  //   // 送られたメッセージの中に `/` が含まれている場合は文字列を分割して保存する
  //   if (events[0].message.text.match(/\//g)) {
  //     const [body, answer] = events[0].message.text.split('/')
  //     const quiz = new Quiz({body, answer})
  //     await quiz.saveToSupabase(supabaseClient(req))
  //     messages = quiz.savedMessages()
  //   }
  //   console.log({reply: messages})
  //   const dataString = JSON.stringify({
  //     replyToken: events[0].replyToken,
  //     messages: messages
  //   })

  //   // リクエストヘッダー
  //   const headers = {
  //     "Content-Type": "application/json",
  //     "Authorization": "Bearer " + Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')
  //   }

  //   // https://developers.line.biz/ja/docs/messaging-api/nodejs-sample/#send-reply
  //   fetch('https://api.line.me/v2/bot/message/reply',
  //     {
  //       method: "POST",
  //       body: dataString,
  //       headers: headers,
  //     }
  //   ).then(r => {console.log(r)})
  //   .catch(e => { console.log(e) })
  // }
  if (events && events[0]?.type === "message") {

    const messages = [
      confirmMessage()
    ]
    const dataString = JSON.stringify({
      replyToken: events[0].replyToken,
      messages: messages
    })

    // リクエストヘッダー
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')
    }

    // https://developers.line.biz/ja/docs/messaging-api/nodejs-sample/#send-reply
    fetch('https://api.line.me/v2/bot/message/reply',
      {
        method: "POST",
        body: dataString,
        headers: headers,
      }
    ).then(r => {console.log(r)})
    .catch(e => { console.log(e) })
  }
  if (events && events[0]?.type === "postback") {
    const dataString = JSON.stringify({
      replyToken: events[0].replyToken,
      messages: [
        {
          "type": "text",
          "text": `data：${events[0].postback.data}`
        }
      ]
    })

    // リクエストヘッダー
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')
    }

    // https://developers.line.biz/ja/docs/messaging-api/nodejs-sample/#send-reply
    fetch('https://api.line.me/v2/bot/message/reply',
      {
        method: "POST",
        body: dataString,
        headers: headers,
      }
    ).then(r => {console.log(r)})
    .catch(e => { console.log(e) })
  }
  return new Response(
    JSON.stringify({status: 'ok'}),
    { headers: { "Content-Type": "application/json" } },
  )
})

// To invoke:
// curl -i --location --request POST 'http://localhost:54321/functions/v1/' \
//   --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
//   --header 'Content-Type: application/json' \
//   --data '{"name":"Functions"}'
