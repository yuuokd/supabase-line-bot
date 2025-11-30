import {
  CustomerDAO,
  FlexTemplateDAO,
  MasterDataDAO,
  StoryDAO,
  StoryTargetDAO,
  SurveyDAO,
  UserFlowDAO,
} from "./dao.ts"
import { FlexMessageBuilder } from "./flexBuilder.ts"
import { LineClient } from "./lineClient.ts"
import {
  Customer,
  LineEvent,
  PostbackPayload,
  SurveyQuestion,
} from "./types.ts"

const PROFILE_STORY_TITLE = "初回プロフィール登録ストーリー"

type MessageRoute = "push" | "reply"

export class WebhookService {
  constructor(
    private deps: {
      customerDao: CustomerDAO
      storyDao: StoryDAO
      flexTemplateDao: FlexTemplateDAO
      userFlowDao: UserFlowDAO
      storyTargetDao: StoryTargetDAO
      surveyDao: SurveyDAO
      masterDao: MasterDataDAO
      lineClient: LineClient
      flexBuilder: FlexMessageBuilder
    },
  ) {}

  async handleEvent(event: LineEvent) {
    switch (event.type) {
      case "follow":
        await this.handleFollow(event)
        break
      case "unfollow":
        await this.handleUnfollow(event)
        break
      case "postback":
        await this.handlePostback(event)
        break
      case "message":
        await this.handleMessage(event)
        break
      default:
        console.log("Unhandled event type", event.type)
    }
  }

  private async handleFollow(event: LineEvent) {
    const lineUserId = event.source?.userId
    if (!lineUserId) return
    const customer = await this.deps.customerDao.upsertFromFollow(
      lineUserId,
      null,
    )
    if (!customer) return

    const story = await this.deps.storyDao.findByTitle(PROFILE_STORY_TITLE)
    if (!story) {
      console.error("Profile story not found")
      return
    }

    const entryNode = await this.deps.storyDao.findEntryNode(story.id)
    if (!entryNode) {
      console.error("Entry node not found for story", story.id)
      return
    }

    await this.deps.userFlowDao.upsertFlow(
      customer.id,
      story.id,
      entryNode.id,
      "in_progress",
    )

    const survey = await this.deps.surveyDao.findByNodeId(entryNode.id)
    const firstQuestion = survey
      ? await this.deps.surveyDao.getQuestionByOrder(survey.id, 1)
      : null

    if (survey) {
      await this.deps.surveyDao.upsertSession(
        survey.id,
        customer.id,
        "in_progress",
        0,
      )
    }

    const template = await this.deps.flexTemplateDao.findById(
      entryNode.flex_template_id,
    )
    if (!template) {
      console.error("Flex template not found for entry node", entryNode.id)
      return
    }

    const message = this.deps.flexBuilder.buildContentMessage(template, {
      title: entryNode.title ?? "お知らせ",
      bodyText: entryNode.body_text ?? "",
      imageUrl: entryNode.image_url,
      primaryLabel: firstQuestion ? "回答を始める" : "確認",
      primaryDisplayText: firstQuestion ? "回答を始める" : "確認",
      primaryData: firstQuestion
        ? {
          action: "start_survey",
          surveyId: survey!.id,
          questionId: firstQuestion.id,
          orderIndex: firstQuestion.order_index,
        }
        : {},
      altText: entryNode.title ?? "お知らせ",
    })

    await this.deps.lineClient.push(lineUserId, [message])
    await this.deps.storyTargetDao.logSent(entryNode.id, customer.id, "sent")
  }

  private async handleUnfollow(event: LineEvent) {
    const lineUserId = event.source?.userId
    if (!lineUserId) return
    await this.deps.customerDao.markBlocked(lineUserId)
  }

  private async handlePostback(event: LineEvent) {
    if (!event.postback?.data) return
    const payload = this.parsePostback(event.postback.data)
    if (!payload) return

    const lineUserId = event.source?.userId
    if (!lineUserId) return
    const customer = await this.deps.customerDao.findByLineUserId(lineUserId)
    if (!customer) return

    switch (payload.action) {
      case "start_survey":
        await this.sendQuestion(
          payload.surveyId,
          payload.orderIndex ?? 1,
          customer,
          "reply",
          event.replyToken,
        )
        break
      case "answer":
        await this.handleAnswerPostback(
          payload,
          customer,
          event.replyToken,
        )
        break
      case "start_free_text":
        await this.handleStartFreeText(payload, customer, event.replyToken)
        break
      default:
        console.log("Unknown postback action", payload.action)
    }
  }

  private async handleMessage(event: LineEvent) {
    const text = event.message?.text ?? ""
    if (!text) return
    const lineUserId = event.source?.userId
    if (!lineUserId) return
    const customer = await this.deps.customerDao.findByLineUserId(lineUserId)
    if (!customer) return

    const activeSession = await this.deps.surveyDao.findActiveSession(
      customer.id,
    )
    if (!activeSession) return

    // Next question is current_order_index + 1
    const nextOrderIndex = (activeSession.current_order_index ?? 0) + 1
    const question = await this.deps.surveyDao.getQuestionByOrder(
      activeSession.survey_id,
      nextOrderIndex,
    )
    if (!question) return

    const template = await this.deps.flexTemplateDao.findById(
      question.flex_template_id,
    )
    if (!template || template.name !== "survey_free_text_with_postback") {
      return
    }

    await this.persistAnswerAndStepNext({
      surveyId: activeSession.survey_id,
      customer,
      question,
      value: text,
      replyToken: event.replyToken,
    })
  }

  private parsePostback(data: string): PostbackPayload | null {
    try {
      return JSON.parse(data) as PostbackPayload
    } catch (error) {
      console.error({ reason: "parsePostback", error, data })
      return null
    }
  }

  private async handleAnswerPostback(
    payload: PostbackPayload,
    customer: Customer,
    replyToken?: string,
  ) {
    if (!payload.surveyId || !payload.questionId) return
    const question = await this.deps.surveyDao.getQuestionById(
      payload.questionId,
    )
    if (!question) return

    await this.persistAnswerAndStepNext({
      surveyId: payload.surveyId,
      customer,
      question,
      optionId: payload.optionId,
      value: payload.optionValue,
      replyToken,
    })
  }

  private async handleStartFreeText(
    payload: PostbackPayload,
    customer: Customer,
    replyToken?: string,
  ) {
    if (!payload.surveyId) return
    const session = await this.deps.surveyDao.getSession(
      payload.surveyId,
      customer.id,
    )
    if (!session) return

    await this.deps.surveyDao.updateSessionStatus(session.id, "awaiting_text")
    if (replyToken) {
      await this.deps.lineClient.reply(replyToken, [
        { type: "text", text: "テキストで回答を入力してください。" },
      ])
    } else {
      await this.deps.lineClient.push(customer.line_user_id, [
        { type: "text", text: "テキストで回答を入力してください。" },
      ])
    }
  }

  private async persistAnswerAndStepNext(
    params: {
      surveyId: string
      customer: Customer
      question: SurveyQuestion
      optionId?: string
      value?: string | null
      replyToken?: string
    },
  ) {
    const { surveyId, customer, question, optionId, value, replyToken } =
      params
    const session = await this.deps.surveyDao.getSession(
      surveyId,
      customer.id,
    )
    const ensuredSession = session ??
      await this.deps.surveyDao.upsertSession(
        surveyId,
        customer.id,
        "in_progress",
        0,
      )
    if (!ensuredSession) return

    const response = await this.deps.surveyDao.upsertResponse(
      surveyId,
      customer.id,
    )
    if (!response) return

    await this.deps.surveyDao.saveOrUpdateAnswer(
      response.id,
      question.id,
      {
        optionId: optionId,
        textAnswer: value ?? null,
      },
    )

    await this.deps.surveyDao.updateSessionProgress(
      ensuredSession.id,
      question.order_index,
      "in_progress",
    )

    const nextQuestion = await this.deps.surveyDao.getQuestionByOrder(
      surveyId,
      question.order_index + 1,
    )

    if (nextQuestion) {
      await this.sendQuestion(
        surveyId,
        nextQuestion.order_index,
        customer,
        replyToken ? "reply" : "push",
        replyToken,
        value,
      )
      return
    }

    // Completed
    await this.deps.surveyDao.updateSessionProgress(
      ensuredSession.id,
      question.order_index,
      "completed",
    )
    await this.deps.surveyDao.markResponseSubmitted(response.id)

    const storyId = await this.deps.surveyDao.getStoryIdBySurveyId(surveyId)
    if (storyId) {
      await this.deps.userFlowDao.completeFlow(customer.id, storyId)
    }

    await this.updateCustomerProfileFromSurvey(surveyId, customer.id)

    const thankYou = { type: "text", text: "回答ありがとうございました！" }
    if (replyToken) {
      await this.deps.lineClient.reply(replyToken, [thankYou])
    } else {
      await this.deps.lineClient.push(customer.line_user_id, [thankYou])
    }
  }

  private async sendQuestion(
    surveyId: string,
    orderIndex: number,
    customer: Customer,
    route: MessageRoute,
    replyToken?: string,
    lastValue?: string | null,
  ) {
    const question = await this.deps.surveyDao.getQuestionByOrder(
      surveyId,
      orderIndex,
    )
    if (!question) return

    const template = await this.deps.flexTemplateDao.findById(
      question.flex_template_id,
    )
    if (!template) return

    let message
    if (template.name === "survey_multi_choice_12") {
      const options = await this.buildOptionsForQuestion(
        question,
        surveyId,
        customer.id,
        lastValue,
      )
      if (!options.length) {
        const fallback = {
          type: "text",
          text: "選択肢を取得できませんでした。少し待ってからもう一度お試しください。",
        }
        if (route === "reply" && replyToken) {
          await this.deps.lineClient.reply(replyToken, [fallback])
        } else {
          await this.deps.lineClient.push(customer.line_user_id, [fallback])
        }
        return
      }
      message = this.deps.flexBuilder.buildMultiChoiceQuestion(
        question,
        template,
        options,
      )
    } else if (template.name === "survey_free_text_with_postback") {
      const payload = {
        label: "入力を開始する",
        displayText: "入力を開始する",
        data: {
          action: "start_free_text",
          surveyId,
          questionId: question.id,
          orderIndex: question.order_index,
        },
      }
      message = this.deps.flexBuilder.buildFreeTextQuestion(
        question,
        template,
        payload,
      )
    } else {
      return
    }

    if (route === "reply" && replyToken) {
      await this.deps.lineClient.reply(replyToken, [message])
    } else {
      await this.deps.lineClient.push(customer.line_user_id, [message])
    }
  }

  private async buildOptionsForQuestion(
    question: SurveyQuestion,
    surveyId: string,
    customerId: string,
    lastValue?: string | null,
  ) {
    const payloadBase = {
      action: "answer" as const,
      surveyId,
      questionId: question.id,
      orderIndex: question.order_index,
    }

    switch (question.order_index) {
      case 1: {
        const grades = await this.deps.masterDao.getGrades(12)
        return grades.map((grade) => ({
          label: grade.display_name,
          displayText: grade.display_name,
          data: {
            ...payloadBase,
            optionValue: grade.id,
          },
        }))
      }
      case 2: {
        const majors = await this.deps.masterDao.getMajors(12)
        return majors.map((major) => ({
          label: major.display_name,
          displayText: major.display_name,
          data: {
            ...payloadBase,
            optionValue: major.id,
          },
        }))
      }
      case 3: {
        const universities = await this.deps.masterDao.getUniversities(12)
        // TODO: paginate universities beyond 12 choices when UX is defined.
        return universities.map((univ) => ({
          label: univ.name,
          displayText: univ.name,
          data: {
            ...payloadBase,
            optionValue: univ.id,
          },
        }))
      }
      case 5: {
        const options = await this.deps.surveyDao.getOptions(question.id)
        return options.map((opt) => ({
          label: opt.label,
          displayText: opt.label,
          data: {
            ...payloadBase,
            optionValue: opt.value,
            optionId: opt.id,
          },
        }))
      }
      case 6: {
        const kanaGroup = lastValue
        if (!kanaGroup) {
          // fallback: attempt to read latest answer for Q5
          const answers = await this.deps.surveyDao.getAnswersBySurveyAndCustomer(
            surveyId,
            customerId,
          )
          const q5 = answers.find((a) => a.orderIndex === 5)
          const group = q5?.value ?? ""
          const prefs = await this.deps.masterDao.getPrefecturesByGroup(
            group,
            12,
          )
          return prefs.map((pref) => ({
            label: pref.display_name,
            displayText: pref.display_name,
            data: {
              ...payloadBase,
              optionValue: pref.id,
            },
          }))
        }
        const prefectures = await this.deps.masterDao
          .getPrefecturesByGroup(kanaGroup, 12)
        return prefectures.map((pref) => ({
          label: pref.display_name,
          displayText: pref.display_name,
          data: {
            ...payloadBase,
            optionValue: pref.id,
          },
        }))
      }
      default:
        // TODO: add other dynamic generations when story expands
        return []
    }
  }

  private async updateCustomerProfileFromSurvey(
    surveyId: string,
    customerId: string,
  ) {
    const answers = await this.deps.surveyDao.getAnswersBySurveyAndCustomer(
      surveyId,
      customerId,
    )
    if (!answers.length) return

    const getValueByOrder = (order: number) =>
      answers.find((a) => a.orderIndex === order)?.value ?? null

    const updates: Record<string, string | null> = {}
    const gradeId = getValueByOrder(1)
    if (gradeId) updates["grade_id"] = gradeId
    const majorId = getValueByOrder(2)
    if (majorId) updates["major_id"] = majorId
    const prefectureId = getValueByOrder(6)
    if (prefectureId) updates["prefecture_id"] = prefectureId

    // TODO: Q3/Q4 university handling when option outside catalog is supported

    if (Object.keys(updates).length > 0) {
      await this.deps.customerDao.updateProfile(customerId, updates)
    }
  }
}
