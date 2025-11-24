// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { supabaseClient } from './supabaseClient.ts'
import { Quiz } from "./quiz.ts"
import { flashCardMessage, replyMessage } from './messages.ts'
import { shuffle } from "./lib.ts"

console.log("Hello from Functions!")

serve(async (req) => {

  const { events } = await req.json()
  console.log(events)

  if (events && events[0]?.type === "message") {
    // 文字列化したメッセージデータ
    let messages:any = [
      {
        "type": "text",
        "text": "こんにちは！"
      },
      {
        "type": "text",
        "text": "テスト / test で単語を登録できます"
      }
    ]

    if (events[0].message.text === 'スタート') {
      const { data, error } = await supabaseClient().from('quiz').select('id,question,answer')
      const quizList = shuffle(data).slice(0, 5)
      // クイズを開始する
      messages = [
        {
          "type": "text",
          "text": "問題を始めるよ！"
        },
        flashCardMessage(quizList[0].question, {list: quizList})
      ]
      console.log({ messages, quizList })

    } else if (events[0].message.text.match(/\//g)) {
      // MEMO:
      // 送られたメッセージの中に `/` が含まれている場合は文字列を分割して保存する
      const [question, answer] = events[0].message.text.split('/')
      const quiz = new Quiz({question, answer})
      await quiz.saveToSupabase(supabaseClient())
      messages = quiz.savedMessages()
    }

    replyMessage(events, messages)
  }

  if (events && events[0]?.type === "postback") {
    const postbackMessages = [
      {
        "type": "text",
        "text": `data：${events[0].postback.data}`
      }
    ]
    const messages = [
      ...postbackMessages
    ]
    
    const postbackData = JSON.parse(events[0].postback.data)
    let [first, ...list] = postbackData.list

    if(postbackData.action === 'nextCard') {
      messages.push({
          "type": "text",
          "text": `こたえは「${first.answer}」です`
      })
    }
    
    if(postbackData.action === 'deleteCard') {
      await supabaseClient().from('quiz').delete().eq('id', first.id)
      messages.push({
          "type": "text",
          "text": "削除しました"
      })
    }
    
    if(list.length > 0) {
       messages.push(
         flashCardMessage(list[0].question, {list: list}) // 続きの問題を返す
       )
     } else {
       messages.push({
         "type": "text",
         "text": `おわったよ！`
       })
     }

    replyMessage(events, messages)
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
