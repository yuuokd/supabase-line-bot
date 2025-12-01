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

// LINE webhook のイベント処理を集約するサービス層
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

  // 受信イベントを種別ごとにハンドラへ振り分ける。未知タイプは無視。
  // 想定利用: Webhook で受け取った events 配列を順に処理する入口。
  async handleEvent(event: LineEvent) {
    switch (event.type) {
      case "follow":
        // 友だち追加。顧客を upsert し、初回ストーリーとアンケートを開始
        await this.handleFollow(event)
        break
      case "unfollow":
        await this.handleUnfollow(event)
        break
      case "postback":
        // ボタン押下や free_text 開始など、postback.data の action で分岐
        await this.handlePostback(event)
        break
      case "message":
        // 記述式回答待ちのときのみテキストを回答として処理
        await this.handleMessage(event)
        break
      default:
        console.log("Unhandled event type", event.type)
    }
  }

  // follow: 顧客レコードを upsert し、初回プロフィールストーリー入口ノードを push。
  // 入口ノードに紐づくアンケートがあれば開始ボタン用 postback を差し込む。
  // 利用シーン: LINE で友だち追加された瞬間にプロフィール登録ストーリーを開始させる。
  private async handleFollow(event: LineEvent) {
    const lineUserId = event.source?.userId
    if (!lineUserId) return
    const profile = await this.deps.lineClient.getProfile(lineUserId)
    const customer = await this.deps.customerDao.upsertFromFollow(
      lineUserId,
      profile?.displayName ?? null,
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

    // 4) user_flows を入口ノードにセットし in_progress にする
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
      // 6) アンケートがあればセッションを初期化（current_order_index=0）
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

    // 7) 初回ノードは content_text_only で Push し、アンケート開始用 postback を付与
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
    const nextDay = this.scheduleAfterDays(4)
    await this.deps.userFlowDao.updateSchedule(
      customer.id,
      story.id,
      nextDay.toISOString(),
    )
  }


  // unfollow: 顧客レコードのis_blocked/opt_in を下げて配信対象から外す。
  private async handleUnfollow(event: LineEvent) {
    const lineUserId = event.source?.userId
    if (!lineUserId) return
    await this.deps.customerDao.markBlocked(lineUserId)
  }

  // postback: survey の開始/回答/記述開始、フロー確認を action ごとに分岐。
  // 利用シーン: ボタン押下時の postback.data を action に応じて個別処理へ渡す。
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
        // ボタンからアンケートを開始（orderIndex 未指定なら 1 問目）
        await this.sendQuestion(
          payload.surveyId,
          payload.orderIndex ?? 1,
          customer,
          "reply",
          event.replyToken,
        )
        break
      case "answer":
        // 選択肢回答を保存して次へ進める
        await this.handleAnswerPostback(
          payload,
          customer,
          event.replyToken,
        )
        break
      case "start_free_text":
        // 記述式の回答待ちに遷移
        await this.handleStartFreeText(payload, customer, event.replyToken)
        break
      case "complete_flow":
        // アンケート無しノードの確認ボタン押下時の応答
        await this.handleCompleteFlow(payload, customer, event.replyToken)
        break
      default:
        console.log("Unknown postback action", payload.action)
    }
  }

  // 通常メッセージのハンドラ。通常メッセージは free_text 回答待ちのセッションにのみ利用し、それ以外は無視。
  // 利用シーン: 記述式質問で「入力を開始」postback を押した後のテキスト回答を保存する。
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

    // 次の質問番号は current_order_index + 1
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

  // postback.data（文字列）を JSON としてパースし、失敗時は null を返す。
  private parsePostback(data: string): PostbackPayload | null {
    try {
      return JSON.parse(data) as PostbackPayload
    } catch (error) {
      console.error({ reason: "parsePostback", error, data })
      return null
    }
  }

  // 選択肢 postback の回答を保存して次へ進めるハンドラ。
  private async handleAnswerPostback(
    payload: PostbackPayload,
    customer: Customer,
    replyToken?: string,
  ) {
    // 利用シーン: ボタン回答（postback）を受けたときに回答を保存し次へ進める。
    if (!payload.surveyId || !payload.questionId) return
    const question = await this.deps.surveyDao.getQuestionById(
      payload.questionId,
    )
    if (!question) return
    const session = await this.deps.surveyDao.getSession(
      payload.surveyId,
      customer.id,
    )
    if (session?.status === "completed") {
      console.log("Survey already completed; ignore answer postback.")
      return
    }

    await this.persistAnswerAndStepNext({
      surveyId: payload.surveyId,
      customer,
      question,
      optionId: payload.optionId,
      value: payload.optionValue,
      replyToken,
    })
  }

  // 記述式質問の「入力を開始」ボタン押下時に呼ばれるハンドラ。
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
    if (!session || session.status === "completed") return

    // 記述式の回答待ち状態にして、次のテキストメッセージを回答扱いにする
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

  // アンケートなし message_node の確認ボタン押下時のハンドラ。ステータスは維持しサンクスのみ返す。
  private async handleCompleteFlow(
    payload: PostbackPayload,
    customer: Customer,
    replyToken?: string,
  ) {
    if (!payload.storyId) return
    // ステータスやスケジュールはいじらず、確認メッセージのみ返す。
    const thankYou = { type: "text", text: "ご確認ありがとうございました。" }
    if (replyToken) {
      await this.deps.lineClient.reply(replyToken, [thankYou])
    } else {
      await this.deps.lineClient.push(customer.line_user_id, [thankYou])
    }
  }

  // 1回答を保存し、次の質問へ進むか完了処理を行う。
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
    // フロー:
    // 1) セッションを取得/作成 → 2) 回答ヘッダを取得/作成 → 3) 回答明細を保存/更新
    // 4) セッション進行度を更新 → 5) 次質問を送信 or 完了処理
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
    if (!ensuredSession || ensuredSession.status === "completed") {
      console.log("Survey already completed; ignore further answers.")
      return
    }

    const response = await this.deps.surveyDao.upsertResponse(
      surveyId,
      customer.id,
    )
    if (!response) return

    // 大学選択: 「その他」以外なら university_id を即保存、記述式はフリーテキストを登録して保存
    if (question.order_index === 3 && value && !this.isOtherUniversity(value)) {
      await this.deps.customerDao.updateProfile(customer.id, {
        university_id: value,
      })
    }
    if (question.order_index === 4 && value) {
      const uniId = await this.deps.masterDao.upsertFreeTextUniversity(value)
      if (uniId) {
        await this.deps.customerDao.updateProfile(customer.id, {
          university_id: uniId,
        })
      }
    }

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

    // 次の質問を決める（大学選択で「その他」以外なら Q4 をスキップする）
    let nextOrderIndex = question.order_index + 1
    let sessionIndex = question.order_index
    if (question.order_index === 3 && value && !this.isOtherUniversity(value)) {
      nextOrderIndex = 5 // 「その他」以外は記述式(Q4)をスキップして Q5 へ
      sessionIndex = 4 // スキップ分も回答済みとして扱うため 4 を記録
    }
    if (question.order_index === 4 && this.isOtherUniversity(value)) {
      // まだ OTHER のままなら安全側で Q5 に進む
      nextOrderIndex = 5
      sessionIndex = 4
    }

    const nextQuestion = await this.deps.surveyDao.getQuestionByOrder(
      surveyId,
      nextOrderIndex,
    )

    if (nextQuestion) {
      const nextValueForLast = question.order_index === 3 && value &&
        !this.isOtherUniversity(value)
        ? undefined
        : value
      await this.sendQuestion(
        surveyId,
        nextQuestion.order_index,
        customer,
        replyToken ? "reply" : "push",
        replyToken,
        nextValueForLast ?? undefined,
      )
      return
    }

    // 全問回答完了時の処理
    await this.deps.surveyDao.updateSessionProgress(
      ensuredSession.id,
      sessionIndex,
      "completed",
    )
    await this.deps.surveyDao.markResponseSubmitted(response.id)

    const storyId = await this.deps.surveyDao.getStoryIdBySurveyId(surveyId)
    const surveyRecord = await this.deps.surveyDao.findById(surveyId)
    const surveyNode = surveyRecord?.node_id
      ? await this.deps.storyDao.getNodeById(surveyRecord.node_id)
      : null
    const nextNodeId = (surveyNode as any)?.next_node_id ?? null

    if (storyId) {
      if (nextNodeId) {
        await this.deps.userFlowDao.updateFlowByCustomerAndStory(
          customer.id,
          storyId,
          nextNodeId,
          this.scheduleAfterDays(4).toISOString(),
          "in_progress",
        )
      } else {
        await this.deps.userFlowDao.completeFlow(customer.id, storyId)
      }
    }

    await this.updateCustomerProfileFromSurvey(surveyId, customer.id)

    const thankYou = { type: "text", text: "回答ありがとうございました！" }
    if (replyToken) {
      await this.deps.lineClient.reply(replyToken, [thankYou])
    } else {
      await this.deps.lineClient.push(customer.line_user_id, [thankYou])
    }
  }

  
  // 次に送るべき質問を Flex メッセージとして組み立て、reply または push で配信する。
  private async sendQuestion(
    surveyId: string,
    orderIndex: number,
    customer: Customer,
    route: MessageRoute,
    replyToken?: string,
    lastValue?: string | null,
  ) {
    // orderIndex で質問を取得し、テンプレート種別に応じてビルダーを使い分ける。
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
    } else if (template.name === "survey_yes_no") {
      const yesPayload = {
        label: "はい",
        displayText: "はい",
        data: {
          action: "answer",
          surveyId,
          questionId: question.id,
          orderIndex: question.order_index,
          optionValue: "yes",
        },
      }
      const noPayload = {
        label: "いいえ",
        displayText: "いいえ",
        data: {
          action: "answer",
          surveyId,
          questionId: question.id,
          orderIndex: question.order_index,
          optionValue: "no",
        },
      }
      message = this.deps.flexBuilder.buildYesNoQuestion(
        question,
        template,
        yesPayload,
        noPayload,
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

  // 質問に埋め込む選択肢を生成。まず survey_options が定義されていればそれを優先。
  // 無ければ質問 order_index ごとにマスタから動的生成し、取得できない場合はエラー選択肢を返す。
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

    // survey_options（question_id に紐づく選択肢）があればそれを採用
    const predefinedOptions = await this.deps.surveyDao.getOptions(
      question.id,
    )
    if (predefinedOptions.length > 0) {
      return predefinedOptions.slice(0, 12).map((opt) => ({
        label: opt.label,
        displayText: opt.label,
        data: {
          ...payloadBase,
          optionValue: opt.value,
          optionId: opt.id,
        },
      }))
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
        // TODO: 12件以上の大学がある場合のページネーションは後続検討
        const baseOptions = universities.map((univ) => {
          const isOther = univ.name === "その他"
          return {
            label: univ.name,
            displayText: univ.name,
            data: {
              ...payloadBase,
              optionValue: isOther ? "OTHER" : univ.id,
            },
          }
        })
        // フリーテキスト用に「その他」が無ければ追加
        const hasOther = baseOptions.some((
          opt,
        ) => opt.label === "その他" || opt.data.optionValue === "OTHER")
        if (!hasOther) {
          baseOptions.push({
            label: "その他",
            displayText: "その他",
            data: { ...payloadBase, optionValue: "OTHER" },
          })
        }
        return baseOptions
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
          // Q5 の回答を取り直してグループを特定するフォールバック
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
        // TODO: 質問が増えた場合はここに候補生成を追加
        return []
    }
  }


  // アンケート完了後、回答内容を customers のプロフィールに反映する。
  // 対応項目: Q1 学年, Q2 専攻, Q3/Q4 大学, Q6 都道府県, Q7 配信許諾（opt_in）
  private async updateCustomerProfileFromSurvey(
    surveyId: string,
    customerId: string,
  ) {
    // 利用シーン: アンケート完了後、回答内容を customers のプロフィールに反映する。
    // 対応項目: Q1 学年, Q2 専攻, Q3/Q4 大学, Q6 都道府県, Q7 配信許諾（opt_in）
    const answers = await this.deps.surveyDao.getAnswersBySurveyAndCustomer(
      surveyId,
      customerId,
    )
    if (!answers.length) return

    const getValueByOrder = (order: number) =>
      answers.find((a) => a.orderIndex === order)?.value ?? null

    const updates: Record<string, string | null | boolean> = {}
    const gradeId = getValueByOrder(1)
    if (gradeId) updates["grade_id"] = gradeId
    const majorId = getValueByOrder(2)
    if (majorId) updates["major_id"] = majorId
    const universityValue = getValueByOrder(3)
    if (universityValue && !this.isOtherUniversity(universityValue)) {
      updates["university_id"] = universityValue
    } else {
      const freeText = getValueByOrder(4)
      if (freeText) {
        const uniId = await this.deps.masterDao.upsertFreeTextUniversity(
          freeText,
        )
        if (uniId) updates["university_id"] = uniId
      }
    }
    const prefectureId = getValueByOrder(6)
    if (prefectureId) updates["prefecture_id"] = prefectureId
    const optInValue = getValueByOrder(7)
    if (optInValue) {
      updates["opt_in"] = optInValue === "yes" ? true : false
      updates["is_blocked"] = optInValue === "yes" ? false : updates["is_blocked"]
    }

    // TODO: Q3/Q4 でカタログ外の大学をより丁寧に扱う場合はここに処理を追加する

    if (Object.keys(updates).length > 0) {
      await this.deps.customerDao.updateProfile(customerId, updates)
    }
  }

  // 大学選択の値が「その他」系かどうかを判定するヘルパー
  private isOtherUniversity(value?: string | null): boolean {
    return value === "OTHER" || value === "その他"
  }

  // 次回配信の予定日時を決めるユーティリティ。
  // 現在から指定日数後の 0:00（UTC 基準のまま）を返す。
  private scheduleAfterDays(days: number): Date {
    const d = new Date()
    d.setDate(d.getDate() + days)
    d.setHours(0, 0, 0, 0) // 0:00 UTC に合わせる
    return d
  }
}
