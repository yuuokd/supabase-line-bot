// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { supabaseClient } from './supabaseClient.ts'
import { flashCardMessage, replyMessage } from './messages.ts'
import { shuffle } from './lib.ts'

serve(async (req) => {
  const { events } = await req.json()
  console.log(events)
  if (events && events[0]?.type === "message") {
    // 文字列化したメッセージデータ
    let messages:any = [
      {
        "type": "text",
        "text": "こんにちはメッセージありがとう！"
      },
      {
        "type": "text",
        "text": "スタートで単語帳を始めることができるよ！"
      }
    ]
    if (events[0].message.text === 'スタート') {
      const { data, error } = await supabaseClient(req).from('quiz').select('question,answer')
      if(error) console.log({error})
      const list = shuffle(data).slice(0, 10)
      // クイズを開始する
      messages = [
        {
          "type": "text",
          "text": "問題をはじめるよ！"
        },
        flashCardMessage(list[0].question, {list: list})
      ]
    } else if (events[0].message.text.match(/\//g)) {
      // MEMO:
      // 送られたメッセージの中に `/` が含まれている場合は文字列を分割して保存する
      const [question, answer] = events[0].message.text
        .replace(/\s+/g, '')  // 空白を削除
        .split('/')           // [question, answer] に分割する
      const { error } = await supabaseClient(req)
        .from('quiz')
        .insert({ answer: answer, question: question })
      if(error) console.log({error})
      messages = [
        {
          "type": "text",
          "text": `単語：${question} / 解答：${answer} を登録しました`
        }
      ]
    }
    console.log({reply: messages})
    replyMessage(events, messages)
  }
  if (events && events[0]?.type === "postback") {
    const postbackMessage = {
      "type": "text",
      "text": `data：${events[0].postback.data}`
    }
    const postbackData = JSON.parse(events[0].postback.data)
    let [first, ...list] = postbackData.list
    if(list.length > 0) {
      // 続きの問題を返す
      const messages = [
        postbackMessage,
        {
          "type": "text",
          "text": `答えは「${first.answer}」だよ`
        },
        flashCardMessage(list[0].question, {list: list})
      ]
      replyMessage(events, messages)
    } else {
      // リセットする
      const messages = [
        postbackMessage,
        {
          "type": "text",
          "text": `答えは「${first.answer}」だよ`
        },
        {
          "type": "text",
          "text": `おわったよ！`
        }
      ]
      replyMessage(events, messages)
    }
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
