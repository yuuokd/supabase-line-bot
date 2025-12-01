import { supabaseClient } from "./supabaseClient.ts"

type SupabaseClient = ReturnType<typeof supabaseClient>

type CustomerRecord = {
    id: string
    line_user_id: string
    is_blocked?: boolean | null
    line_display_name?: string | null
}

type UpsertCustomerInput = {
    line_user_id: string
    line_display_name?: string | null
    is_blocked?: boolean
    blocked_at?: string | null
    opt_in?: boolean
    updated_at?: string
}

// LINE公式 API を使ってフォロワーやプロフィールを取得するクライアント
// - fetchFollowers/fetchAllFollowerIds: フォロワーID一覧取得（ページネーション対応）
// - fetchProfile: userId からプロフィール情報を取得
export class LineApiClient {
    private accessToken: string
    private headers: Record<string, string>

    constructor(accessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "") {
        this.accessToken = accessToken
        this.headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.accessToken}`,
        }
    }

    // フォロワーIDを取得（LINE APIのページネーションstart対応）
    async fetchFollowers(start?: string) {
        const url = new URL("https://api.line.me/v2/bot/followers/ids")
        if (start) {
            url.searchParams.set("start", start)
        }

        const res = await fetch(url.toString(), {
            method: "GET",
            headers: this.headers,
        })

        if (!res.ok) {
            console.error({
                caused: "LineApiClient.fetchFollowers",
                status: res.status,
                statusText: res.statusText,
            })
            throw new Error("Failed to fetch followers from LINE API")
        }

        const data = await res.json()
        return {
            userIds: data.userIds ?? [],
            next: data.next as string | undefined,
        }
    }

    // すべてのフォロワーIDを取得（ページを跨いで連結）
    async fetchAllFollowerIds(): Promise<string[]> {
        let next: string | undefined
        const followerIds: string[] = []

        do {
            const { userIds, next: nextToken } = await this.fetchFollowers(next)
            followerIds.push(...userIds)
            next = nextToken
        } while (next)

        return followerIds
    }

    // 1ユーザーのプロフィール情報を取得（displayName 取得に利用）
    async fetchProfile(userId: string) {
        const res = await fetch(
            `https://api.line.me/v2/bot/profile/${userId}`,
            {
                method: "GET",
                headers: this.headers,
            },
        )

        if (!res.ok) {
            console.error({
                caused: "LineApiClient.fetchProfile",
                status: res.status,
                statusText: res.statusText,
                userId,
            })
            return null
        }

        return await res.json()
    }
}

// Supabase の customers / user_flows を扱うリポジトリ（同期バッチ用）
// - fetchAll: 既存顧客一覧を取得
// - upsertAll: 顧客配列をまとめて挿入/更新（ユニーク制約に依存しないfallback）
// - markBlocked/markActive: ブロック/復帰時のフラグ更新
export class CustomerRepository {
    private client: SupabaseClient

    constructor(client: SupabaseClient) {
        this.client = client
    }

    async fetchAll(): Promise<CustomerRecord[]> {
        const { data, error } = await this.client
            .from("customers")
            .select("id,line_user_id,is_blocked")

        if (error) {
            console.error({ caused: "CustomerRepository.fetchAll", error })
            return []
        }

        return data ?? []
    }

    async findByLineUserId(lineUserId: string): Promise<CustomerRecord | null> {
        const { data, error } = await this.client
            .from("customers")
            .select("id,line_user_id,is_blocked,line_display_name")
            .eq("line_user_id", lineUserId)
            .maybeSingle()

        if (error) {
            console.error({ caused: "CustomerRepository.findByLineUserId", error })
            return null
        }

        return data ?? null
    }

    // まとめて顧客を upsert（既存を確認して insert/update を分岐）
    async upsertAll(customers: UpsertCustomerInput[]) {
        if (customers.length === 0) return

        await this.fallbackMerge(customers)
    }

    // customers リストを既存/新規に分けて insert または update を実行
    private async fallbackMerge(customers: UpsertCustomerInput[]) {
        const ids = customers.map((c) => c.line_user_id)
        const { data, error } = await this.client
            .from("customers")
            .select("line_user_id")
            .in("line_user_id", ids)

        if (error) {
            console.error({ caused: "CustomerRepository.fallbackMerge.select", error })
            return
        }

        const existingSet = new Set((data ?? []).map((c) => c.line_user_id))
        const inserts = customers.filter((c) => !existingSet.has(c.line_user_id))
        const updates = customers.filter((c) => existingSet.has(c.line_user_id))

        if (inserts.length > 0) {
            const { error: insertError } = await this.client
                .from("customers")
                .insert(inserts)
            if (insertError) {
                console.error({ caused: "CustomerRepository.fallbackMerge.insert", insertError })
            }
        }

        for (const customer of updates) {
            const { error: updateError } = await this.client
                .from("customers")
                .update({
                    line_display_name: customer.line_display_name,
                    is_blocked: customer.is_blocked,
                    blocked_at: customer.blocked_at,
                    opt_in: customer.opt_in,
                    updated_at: customer.updated_at,
                })
                .eq("line_user_id", customer.line_user_id)

            if (updateError) {
                console.error({
                    caused: "CustomerRepository.fallbackMerge.update",
                    line_user_id: customer.line_user_id,
                    updateError,
                })
            }
        }
    }

    // ブロック状態に更新（is_blocked=true, blocked_at 打刻）
    async markBlocked(lineUserIds: string[], blockedAt: string) {
        if (lineUserIds.length === 0) return

        const { error } = await this.client
            .from("customers")
            .update({
                is_blocked: true,
                blocked_at: blockedAt,
                updated_at: blockedAt,
            })
            .in("line_user_id", lineUserIds)

        if (error) {
            console.error({ caused: "CustomerRepository.markBlocked", error })
        }
    }

    // ブロック解除時の処理（is_blocked=false, opt_in=true へ戻し、関連 user_flows を in_progress に戻す）
    async markActive(lineUserIds: string[], updatedAt: string) {
        if (lineUserIds.length === 0) return

        const { data: customers, error } = await this.client
            .from("customers")
            .update({
                is_blocked: false,
                blocked_at: null,
                opt_in: true,
                updated_at: updatedAt,
            })
            .in("line_user_id", lineUserIds)
            .select("id")

        if (error) {
            console.error({ caused: "CustomerRepository.markActive", error })
            return
        }

        const customerIds = (customers ?? []).map((c) => c.id)
        if (customerIds.length > 0) {
            const { error: flowError } = await this.client
                .from("user_flows")
                .update({
                    status: "in_progress",
                    updated_at: updatedAt,
                })
                .in("customer_id", customerIds)
            if (flowError) {
                console.error({ caused: "CustomerRepository.markActive.user_flows", flowError })
            }
        }
    }
}

// LINE フォロワーの同期と顧客レコードの生成/復帰を行うサービス
// - registerNewFriend: 単一ユーザーのフォローに応じて顧客作成
// - markAsUnfollowed: 個別の unfollow をブロック状態に反映
// - syncFollowers: 現在のフォロワー一覧とDBを突き合わせ、追加/再開/ブロックを一括更新
export class FriendService {
    private lineClient: LineApiClient
    private customerRepository: CustomerRepository

    constructor(lineClient: LineApiClient, customerRepository: CustomerRepository) {
        this.lineClient = lineClient
        this.customerRepository = customerRepository
    }

    // 単一ユーザーのフォローを検知した際に顧客を upsert する。表示名も保存。
    async registerNewFriend(userId?: string) {
        if (!userId) return
        const now = new Date().toISOString()
        const profile = await this.lineClient.fetchProfile(userId)

        const customer: UpsertCustomerInput = {
            line_user_id: userId,
            line_display_name: profile?.displayName ?? null,
            is_blocked: false,
            blocked_at: null,
            opt_in: true,
            updated_at: now,
        }

        await this.customerRepository.upsertAll([customer])

        const existing = await this.customerRepository.findByLineUserId(userId)
        return existing?.id
    }

    // unfollow を受けた個別ユーザーをブロック扱いにする
    async markAsUnfollowed(userId?: string) {
        if (!userId) return
        const now = new Date().toISOString()
        await this.customerRepository.markBlocked([userId], now)
    }

    // LINE 上のフォロワー一覧と DB を突き合わせ、追加/復帰/ブロックを一括反映
    // - followerIds: LINE API から現時点のフォロワーID一覧
    // - existingCustomers: DB 既存顧客一覧
    // - newIds: LINE にはいるが DB にいない → 新規作成
    // - reactivatedIds: DB では is_blocked=true だが LINE にはいる → ブロック解除
    // - blockedIds: DB では未ブロックだが LINE にはいない → ブロック扱いに更新
    try {
            const followerIds = await this.lineClient.fetchAllFollowerIds()
            const existingCustomers = await this.customerRepository.fetchAll()
            const followerSet = new Set(followerIds)
            const existingSet = new Set(
                existingCustomers.map((c) => c.line_user_id),
            )
            const now = new Date().toISOString()

            const newIds = followerIds.filter((id) => !existingSet.has(id))
            const reactivatedIds = existingCustomers
                .filter((customer) =>
                    Boolean(customer.is_blocked) && followerSet.has(customer.line_user_id)
                )
                .map((customer) => customer.line_user_id)
            const blockedIds = existingCustomers
                .filter((customer) =>
                    !followerSet.has(customer.line_user_id) &&
                    !customer.is_blocked
                )
                .map((customer) => customer.line_user_id)

            const newCustomers = await this.buildNewCustomers(newIds, now)
            await this.customerRepository.upsertAll(newCustomers)
            await this.customerRepository.markActive(reactivatedIds, now)
            await this.customerRepository.markBlocked(blockedIds, now)

            return {
                totalFollowers: followerIds.length,
                added: newCustomers.length,
                reactivated: reactivatedIds.length,
                blocked: blockedIds.length,
            }
        } catch (error) {
            console.error({ caused: "FriendService.syncFollowers", error })
            return {
                totalFollowers: 0,
                added: 0,
                reactivated: 0,
                blocked: 0,
                error: "Failed to sync followers",
            }
        }
    }

    // 新規フォロワー ID 群から顧客作成用のデータを組み立てる
    private async buildNewCustomers(ids: string[], updatedAt: string) {
        const customers: UpsertCustomerInput[] = []

        for (const id of ids) {
            const profile = await this.lineClient.fetchProfile(id)
            customers.push({
                line_user_id: id,
                line_display_name: profile?.displayName ?? null,
                is_blocked: false,
                blocked_at: null,
                opt_in: true,
                updated_at,
            })
        }

        return customers
    }
}
