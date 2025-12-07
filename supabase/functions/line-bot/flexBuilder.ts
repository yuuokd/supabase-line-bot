import { FlexTemplate, LineMessage, SurveyQuestion } from "./types.ts"

type OptionPayload = {
  label: string
  data: Record<string, unknown>
  displayText?: string
}

// Flex テンプレートのプレースホルダを差し込み、LINE メッセージを構築するビルダー。
// - buildContentMessage: 通常コンテンツ配信用（タイトル/本文/画像＋ボタン）
// - buildContentFromCards: message_node_cards を受け取り、1件ならバブル、複数ならカルーセルで返す
// - buildMultiChoiceQuestion: 複数選択式アンケート（survey_multi_choice_12 前提）
// - buildYesNoQuestion: Yes/No 質問（survey_yes_no 前提）
// - buildFreeTextQuestion: 記述式開始ボタン付き質問（survey_free_text_with_postback 前提）
// いずれもテンプレートに期待される {PLACEHOLDER} を置換し、postback data を埋め込む。
export class FlexMessageBuilder {

  // buildContentMessage: 通常コンテンツ配信用（タイトル/本文/画像＋ボタン）
  buildContentMessage(
    template: FlexTemplate,
    params: {
      title: string
      bodyText: string
      primaryLabel?: string
      primaryData?: Record<string, unknown>
      primaryDisplayText?: string
      imageUrl?: string | null
      altText?: string
    },
  ): LineMessage {
    // コンテンツ用バブルにタイトル/本文/メインボタンを差し込む
    const bubble = this.deepClone(template.layout_json)
    const replacements: Record<string, string> = {
      "{TITLE}": params.title,
      "{BODY_TEXT}": params.bodyText,
      "{PRIMARY_LABEL}": params.primaryLabel ?? "回答する",
      "{PRIMARY_DATA}": JSON.stringify(params.primaryData ?? {}),
      "{PRIMARY_DISPLAY}":
        params.primaryDisplayText ?? params.primaryLabel ?? "回答する",
      "{IMAGE_URL}": params.imageUrl ?? "",
    }

    const filled = this.replacePlaceholders(bubble, replacements)
    return this.toFlexMessage(
      filled,
      params.altText ?? params.title ?? "メッセージ",
    )
  }

  // message_node_cards を元にバブルを生成し、1件なら単一バブル、複数ならカルーセルで返す
  buildContentFromCards(
    template: FlexTemplate,
    cards: { title?: string | null; body_text?: string | null; image_url?: string | null }[],
    params: {
      primaryLabel?: string
      primaryData?: Record<string, unknown>
      primaryDisplayText?: string
      altText?: string
    },
  ): LineMessage {
    const bubbles = cards.map((card) =>
      this.buildContentBubble(template, {
        title: card.title ?? "お知らせ",
        bodyText: card.body_text ?? "",
        primaryLabel: params.primaryLabel,
        primaryData: params.primaryData,
        primaryDisplayText: params.primaryDisplayText,
        imageUrl: card.image_url ?? null,
        altText: params.altText ?? card.title ?? "お知らせ",
      })
    )

    if (bubbles.length <= 1) {
      return bubbles[0] ?? this.toFlexMessage(template.layout_json, "メッセージ")
    }

    return {
      type: "flex",
      altText: params.altText ?? cards[0]?.title ?? "メッセージ",
      contents: {
        type: "carousel",
        contents: bubbles.map((b) => b.contents as Record<string, unknown>),
      },
    }
  }

  private buildContentBubble(
    template: FlexTemplate,
    params: {
      title: string
      bodyText: string
      primaryLabel?: string
      primaryData?: Record<string, unknown>
      primaryDisplayText?: string
      imageUrl?: string | null
      altText?: string
    },
  ): LineMessage {
    const bubble = this.deepClone(template.layout_json)
    // 画像URLが無い場合や不正なスキームの場合は hero を取り除く（LINE側のバリデーション回避）
    const safeImage = params.imageUrl &&
      (params.imageUrl.startsWith("http://") ||
        params.imageUrl.startsWith("https://"))
      ? params.imageUrl
      : null
    if (!safeImage && (bubble as any).hero) {
      delete (bubble as any).hero
    }
    const replacements: Record<string, string> = {
      "{TITLE}": params.title,
      "{BODY_TEXT}": params.bodyText,
      "{PRIMARY_LABEL}": params.primaryLabel ?? "確認",
      "{PRIMARY_DATA}": JSON.stringify(params.primaryData ?? {}),
      "{PRIMARY_DISPLAY}":
        params.primaryDisplayText ?? params.primaryLabel ?? "確認",
      "{IMAGE_URL}": safeImage ?? "",
    }

    const filled = this.replacePlaceholders(bubble, replacements)
    return this.toFlexMessage(
      filled,
      params.altText ?? params.title ?? "メッセージ",
    )
  }


  // buildMultiChoiceQuestion: 複数選択式アンケート（survey_multi_choice_12 前提）
  buildMultiChoiceQuestion(
    question: SurveyQuestion,
    template: FlexTemplate,
    options: OptionPayload[],
  ): LineMessage {
    // survey_multi_choice_12 用の 12 ボタンに postback を割り当てる
    const rawBubble: any = this.deepClone(template.layout_json)
    const replacements: Record<string, string> = {
      "{QUESTION_TITLE}": question.question_title,
      "{QUESTION_TEXT}": question.question_text,
    }
    const bubble = this.replacePlaceholders(rawBubble, replacements)

    // template expectation: body.contents[3] is button box
    const contentsBox = bubble?.body?.contents?.[3]?.contents
    if (Array.isArray(contentsBox)) {
      const limitedOptions = options.slice(0, Math.min(12, options.length))
      const filledButtons = limitedOptions.map((option, index) => {
        const buttonTemplate = contentsBox[index]
        const dataString = JSON.stringify(option.data)
        return this.replacePlaceholders(buttonTemplate, {
          [`{OPTION${index + 1}_LABEL}`]: option.label,
          [`{OPTION${index + 1}_DISPLAY}`]:
            option.displayText ?? option.label,
          [`{OPTION${index + 1}_DATA}`]: dataString,
        })
      })
      bubble.body.contents[3].contents = filledButtons
    }

    return this.toFlexMessage(
      bubble,
      question.question_text ?? "アンケート",
    )
  }

  
  // buildYesNoQuestion: Yes/No 質問（survey_yes_no 前提）
  buildYesNoQuestion(
    question: SurveyQuestion,
    template: FlexTemplate,
    yesPayload: OptionPayload,
    noPayload: OptionPayload,
  ): LineMessage {
    // Yes/No 2択を持つテンプレに postback を埋め込む
    const bubble = this.deepClone(template.layout_json)
    const filled = this.replacePlaceholders(bubble, {
      "{QUESTION_TITLE}": question.question_title,
      "{QUESTION_TEXT}": question.question_text,
      "{YES_LABEL}": yesPayload.label,
      "{YES_DISPLAY}": yesPayload.displayText ?? yesPayload.label,
      "{YES_DATA}": JSON.stringify(yesPayload.data),
      "{NO_LABEL}": noPayload.label,
      "{NO_DISPLAY}": noPayload.displayText ?? noPayload.label,
      "{NO_DATA}": JSON.stringify(noPayload.data),
    })
    return this.toFlexMessage(
      filled,
      question.question_text ?? "アンケート",
    )
  }


  // buildFreeTextQuestion: 記述式開始ボタン付き質問（survey_free_text_with_postback 前提）
  buildFreeTextQuestion(
    question: SurveyQuestion,
    template: FlexTemplate,
    payload: OptionPayload,
  ): LineMessage {
    // 記述式開始ボタン付きテンプレに postback を埋め込む
    const bubble = this.deepClone(template.layout_json)
    const filled = this.replacePlaceholders(bubble, {
      "{QUESTION_TITLE}": question.question_title,
      "{QUESTION_TEXT}": question.question_text,
      "{START_LABEL}": payload.label,
      "{START_DISPLAY}": payload.displayText ?? payload.label,
      "{START_DATA}": JSON.stringify(payload.data),
    })
    return this.toFlexMessage(
      filled,
      question.question_text ?? "アンケート",
    )
  }

  private replacePlaceholders(
    node: unknown,
    replacements: Record<string, string>,
  ): any {
    // JSON/配列/文字列に対し {KEY} を置換して再帰的に返す
    if (typeof node === "string") {
      let replaced = node
      Object.entries(replacements).forEach(([key, value]) => {
        replaced = replaced.replaceAll(key, value)
      })
      return replaced
    }

    if (Array.isArray(node)) {
      return node.map((item) => this.replacePlaceholders(item, replacements))
    }

    if (node !== null && typeof node === "object") {
      const result: Record<string, unknown> = {}
      Object.entries(node as Record<string, unknown>).forEach(
        ([k, v]) => {
          result[k] = this.replacePlaceholders(v, replacements)
        },
      )
      return result
    }

    return node
  }

  private deepClone<T>(value: T): T {
    // テンプレートを破壊しないよう JSON 経由でディープコピー
    return JSON.parse(JSON.stringify(value))
  }

  private toFlexMessage(contents: Record<string, unknown>, altText: string) {
    // LINE Flex Message 形式に整形
    return {
      type: "flex",
      altText,
      contents,
    }
  }
}
