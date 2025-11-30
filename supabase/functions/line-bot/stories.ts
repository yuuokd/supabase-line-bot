import { supabaseClient } from "./supabaseClient.ts"

type SupabaseClient = ReturnType<typeof supabaseClient>

type StoryRecord = { id: string }
type MessageNodeRecord = {
    id: string
    title?: string | null
    body_text?: string | null
    image_url?: string | null
    layout_json?: Record<string, unknown> | null
}

const DEFAULT_PROFILE_STORY_TITLE =
    Deno.env.get("INITIAL_PROFILE_STORY_TITLE") ?? "初回プロフィール登録ストーリー"

export class StoryRepository {
    private client: SupabaseClient

    constructor(client: SupabaseClient) {
        this.client = client
    }

    async findStoryIdByTitle(title: string): Promise<string | null> {
        const { data, error } = await this.client
            .from("stories")
            .select("id")
            .eq("title", title)
            .limit(1)
            .maybeSingle()

        if (error) {
            console.error({ caused: "StoryRepository.findStoryIdByTitle", error })
            return null
        }

        return (data as StoryRecord | null)?.id ?? null
    }

    async findEntryNodeId(storyId: string): Promise<string | null> {
        const { data, error } = await this.client
            .from("message_nodes")
            .select("id")
            .eq("story_id", storyId)
            .is("prev_node_id", null)
            .limit(1)
            .maybeSingle()

        if (error) {
            console.error({ caused: "StoryRepository.findEntryNodeId", error, storyId })
            return null
        }

        return (data as MessageNodeRecord | null)?.id ?? null
    }

    async findEntryNodeWithTemplate(storyId: string): Promise<MessageNodeRecord | null> {
        const { data, error } = await this.client
            .from("message_nodes")
            .select("id,title,body_text,image_url,flex_templates!inner(layout_json)")
            .eq("story_id", storyId)
            .is("prev_node_id", null)
            .limit(1)
            .maybeSingle()

        if (error) {
            console.error({ caused: "StoryRepository.findEntryNodeWithTemplate", error, storyId })
            return null
        }

        if (!data) return null

        return {
            id: data.id,
            title: data.title,
            body_text: data.body_text,
            image_url: data.image_url,
            layout_json: (data as any).flex_templates?.layout_json ?? null,
        }
    }
}

export class UserFlowRepository {
    private client: SupabaseClient

    constructor(client: SupabaseClient) {
        this.client = client
    }

    async upsertUserFlow(params: {
        customerId: string
        storyId: string
        currentNodeId: string | null
        status?: "in_progress" | "completed"
        nextScheduledAt?: string | null
    }) {
        const now = new Date().toISOString()
        const { error } = await this.client
            .from("user_flows")
            .upsert(
                {
                    customer_id: params.customerId,
                    story_id: params.storyId,
                    current_node_id: params.currentNodeId,
                    status: params.status ?? "in_progress",
                    next_scheduled_at: params.nextScheduledAt ?? null,
                    updated_at: now,
                },
                { onConflict: "customer_id,story_id" },
            )

        if (error) {
            console.error({ caused: "UserFlowRepository.upsertUserFlow", error })
        }
    }
}

export class StoryEnrollmentService {
    private storyRepository: StoryRepository
    private userFlowRepository: UserFlowRepository
    private profileStoryTitle: string

    constructor(
        storyRepository: StoryRepository,
        userFlowRepository: UserFlowRepository,
        profileStoryTitle = DEFAULT_PROFILE_STORY_TITLE,
    ) {
        this.storyRepository = storyRepository
        this.userFlowRepository = userFlowRepository
        this.profileStoryTitle = profileStoryTitle
    }

    async startInitialProfileStory(customerId?: string) {
        if (!customerId) return null

        const storyId = await this.storyRepository.findStoryIdByTitle(
            this.profileStoryTitle,
        )

        if (!storyId) {
            console.error({
                caused: "StoryEnrollmentService.startInitialProfileStory",
                reason: "story not found",
                title: this.profileStoryTitle,
            })
            return null
        }

        const entryNode = await this.storyRepository.findEntryNodeWithTemplate(storyId)

        await this.userFlowRepository.upsertUserFlow({
            customerId,
            storyId,
            currentNodeId: entryNode?.id ?? null,
            status: "in_progress",
        })

        return buildEntryMessage(entryNode, storyId)
    }
}

const buildEntryMessage = (entryNode: MessageNodeRecord | null, storyId: string) => {
    if (entryNode?.layout_json) {
        const placeholderValues: Record<string, string> = {
            TITLE: entryNode.title ?? "プロフィール登録のお願い",
            BODY_TEXT: entryNode.body_text ??
                "あなたに合った情報をお届けするため、基本プロフィールの入力をお願いします。",
            IMAGE_URL: entryNode.image_url ?? "",
            PRIMARY_LABEL: "登録する",
            PRIMARY_DISPLAY: "登録する",
            PRIMARY_DATA: JSON.stringify({
                action: "start_profile_story",
                storyId,
                nodeId: entryNode.id,
            }),
        }

        const contents = renderTemplate(entryNode.layout_json, placeholderValues)
        return {
            type: "flex",
            altText: placeholderValues.TITLE,
            contents,
        }
    }

    // Fallback text message
    const title = entryNode?.title ?? "プロフィール登録のお願い"
    const body = entryNode?.body_text ??
        "あなたに合った情報をお届けするため、基本プロフィールの入力をお願いします。"
    return {
        type: "text",
        text: `${title}\n${body}`,
    }
}

const renderTemplate = (
    layout: Record<string, unknown>,
    replacements: Record<string, string>,
) => {
    const raw = JSON.stringify(layout)
    const replaced = raw.replace(
        /\{([A-Z0-9_]+)\}/g,
        (_, key) => replacements[key] ?? "",
    )
    return JSON.parse(replaced)
}
