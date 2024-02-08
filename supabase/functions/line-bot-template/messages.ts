export const flashCardMessage = (question, data?) => {
    const actions = [
      {
        "type": "postback",
        "label": "答えを見る",
        "inputOption": "openRichMenu",
        "data": JSON.stringify({action: 'nextCard', ...data}),
      }
    ]

    // valdiation
    // https://developers.line.biz/en/reference/messaging-api/#action-objects
    actions.forEach((action) => {
      if(action.type === 'postback' && action.data.length > 300) {
        console.error({reason: 'postback.data は最大で 300 文字までです', data: action.data})
      }
      if(action.type === 'postback' && action.label.length > 20) {
        console.error({reason: 'postback.label は最大で 20 文字までです', data: action.label})
      }
    })

    return {
      "type": "template",
      "altText": "単語帳のメッセージを表示中",
      "template": {
        "type": "buttons",
        "text": `「${question}」`,
        "actions": actions
      }
    }
}

export const replyMessage = (events, messages) => {
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

export const flexMessage = (contents) => {
    return {
        "type": "flex",
        "altText": "This is a Flex Message",
        "contents": contents
    }
}
