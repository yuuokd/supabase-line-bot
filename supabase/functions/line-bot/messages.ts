class ActionValidator {
    validate(action) {
        switch (action.type) {
            case "postback":
                this.validatePostback(action)
                break
            default:
                break
        }
    }

    validatePostback(action) {
        if (action.data && action.data.length > 300) {
            console.error({
                reason: "postback.data は最大で 300 文字までです",
                data: action.data,
            })
        }

        if (action.label && action.label.length > 20) {
            console.error({
                reason: "postback.label は最大で 20 文字までです",
                data: action.label,
            })
        }
    }
}

export const flashCardMessage = (question, data?) => {
    const validator = new ActionValidator()

    const actions = [
        {
            type: "postback",
            label: "答えを見る",
            inputOption: "openRichMenu",
            data: JSON.stringify({ action: "nextCard", ...data }),
        },
        {
            type: "postback",
            label: "削除する",
            data: JSON.stringify({ action: "deleteCard", ...data }),
        },
        {
            type: "clipboard",
            label: "コピーする",
            clipboardText: question,
        },
    ]

    // validation 実行（postback だけが対象）
    actions.forEach((action) => validator.validate(action))

    const bubble = {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
                {
                    type: "text",
                    text: question,
                    wrap: true,
                    weight: "bold",
                    size: "xl",
                },
            ],
        },
        footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
                {
                    type: "button",
                    style: "primary",
                    action: actions[0], // 答えを見る
                },
                {
                    type: "button",
                    style: "primary",
                    color: "#E50000",
                    action: actions[1], // 削除する
                },
                {
                    type: "button",
                    action: actions[2], // コピーする
                },
            ],
        },
    }

    return flexMessage(bubble, "単語帳のメッセージを表示中")
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

export const flashCardFlexMessage = (question, data?) => {
    const validator = new ActionValidator()

    const actions = [
        {
            type: "postback",
            label: "答えを見る",
            data: JSON.stringify({ action: "nextCard", ...data }),
        },
        {
            type: "postback",
            label: "削除する",
            data: JSON.stringify({ action: "deleteCard", ...data }),
        },
        {
            type: "clipboard",
            label: "コピーする",
            clipboardText: question,
        },
    ]

    actions.forEach((action) => validator.validate(action))

    const bubble = {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
                {
                    type: "text",
                    text: question,
                    wrap: true,
                    weight: "bold",
                    size: "xl",
                },
            ],
        },
        footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
                {
                    type: "button",
                    style: "primary",
                    action: actions[0],
                },
                {
                    type: "button",
                    action: actions[1],
                    color: "#E50000",
                    style: "primary",
                },
                {
                    type: "button",
                    action: actions[2],
                },
            ],
        },
    }

    return flexMessage(bubble, "単語帳のメッセージを表示中")
}

export const flexMessage = (contents, altText = "This is a Flex Message") => {
    return {
        type: "flex",
        altText,
        contents,
    }
}
