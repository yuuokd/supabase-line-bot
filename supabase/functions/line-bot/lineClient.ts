import { LineMessage } from "./types.ts"

// LINE Messaging API との通信・署名検証を担当するヘルパー。
// 利用シーン:
// - getProfile: フォロー時に displayName などを取得し DB に保存する
// - validateSignature: Webhook 受信時にリクエスト改ざんを検知する
// - reply / push: Webhook ハンドラやスケジューラからメッセージを送信する
export class LineClient {
  constructor(
    private accessToken: string,
    private channelSecret?: string | null,
  ) {}

  // LINE プロフィール取得（フォロー時の表示名取得などに利用）
  async getProfile(userId: string): Promise<
    | { displayName?: string; pictureUrl?: string; statusMessage?: string }
    | null
  > {
    console.log({
      direction: "outgoing",
      target: "line",
      action: "getProfile",
      userId,
    })
    try {
      const res = await fetch(
        `https://api.line.me/v2/bot/profile/${userId}`,
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        },
      )
      console.log({
        direction: "incoming",
        target: "line",
        action: "getProfile",
        status: res.status,
      })
      if (!res.ok) {
        console.error({
          reason: "LineClient.getProfile",
          status: res.status,
          text: await res.text(),
        })
        return null
      }
      return await res.json()
    } catch (error) {
      console.error({ reason: "LineClient.getProfile.fetch_error", error })
      return null
    }
  }

  // LINE 署名検証（channel secret 未設定時はスキップ）。Webhook 改ざん防止に利用。
  async validateSignature(
    bodyText: string,
    signatureHeader: string | null,
  ): Promise<boolean> {
    if (!this.channelSecret) {
      console.warn("LINE channel secret is not set; skipping signature verify.")
      return true
    }
    if (!signatureHeader) return false
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.channelSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(bodyText),
    )
    const base64Signature = btoa(
      String.fromCharCode(...new Uint8Array(signature)),
    )
    return base64Signature === signatureHeader
  }

  // Reply API 呼び出し（Webhook で replyToken がある場合に利用）
  async reply(replyToken: string, messages: LineMessage[]) {
    console.log({
      direction: "outgoing",
      target: "line",
      action: "reply",
      payload: { replyToken, messages },
    })
    return await this.post("https://api.line.me/v2/bot/message/reply", {
      replyToken,
      messages,
    })
  }

  // Push API 呼び出し（replyToken が無い場合や定期配信で利用）
  async push(to: string, messages: LineMessage[]) {
    console.log({
      direction: "outgoing",
      target: "line",
      action: "push",
      payload: { to, messages },
    })
    return await this.post("https://api.line.me/v2/bot/message/push", {
      to,
      messages,
    })
  }

  // 内部共通の POST ラッパー。LINE API 呼び出し結果をロギングし、非 2xx ならエラーログ。
  private async post(url: string, payload: Record<string, unknown>) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(payload),
      })
      console.log({
        direction: "incoming",
        target: "line",
        action: "post",
        url,
        status: res.status,
      })
      if (!res.ok) {
        const text = await res.text()
        console.error({ reason: "LineClient.post", status: res.status, text })
      }
      return res
    } catch (error) {
      console.error({ reason: "LineClient.post.fetch_error", error })
      throw error
    }
  }
}
