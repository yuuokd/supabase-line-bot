import { FlexTemplate, LineMessage, SurveyQuestion } from "./types.ts"

type OptionPayload = {
  label: string
  data: Record<string, unknown>
  displayText?: string
}

export class FlexMessageBuilder {
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

  buildMultiChoiceQuestion(
    question: SurveyQuestion,
    template: FlexTemplate,
    options: OptionPayload[],
  ): LineMessage {
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

  buildYesNoQuestion(
    question: SurveyQuestion,
    template: FlexTemplate,
    yesPayload: OptionPayload,
    noPayload: OptionPayload,
  ): LineMessage {
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

  buildFreeTextQuestion(
    question: SurveyQuestion,
    template: FlexTemplate,
    payload: OptionPayload,
  ): LineMessage {
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
    return JSON.parse(JSON.stringify(value))
  }

  private toFlexMessage(contents: Record<string, unknown>, altText: string) {
    return {
      type: "flex",
      altText,
      contents,
    }
  }
}
