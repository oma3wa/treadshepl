/** Типы данных Threads API и внутренних сущностей бота. */

/** Разрешения (scopes) Threads API. threads_basic обязателен всегда. */
export const SCOPES = [
  "threads_basic",
  "threads_content_publish",
  "threads_manage_replies",
  "threads_read_replies",
  "threads_manage_insights",
] as const

export type Scope = (typeof SCOPES)[number]

/** Тип медиа при создании контейнера публикации. */
export type MediaType = "TEXT" | "IMAGE" | "VIDEO" | "CAROUSEL"

/** Сохранённый долгоживущий токен доступа. */
export interface StoredToken {
  accessToken: string
  userId: string
  /** Unix-время в миллисекундах, когда токен перестанет действовать */
  expiresAt: number
  /** Когда токен был получен или последний раз продлён */
  savedAt: string
}

/** Профиль пользователя Threads. */
export interface ThreadsProfile {
  id: string
  username?: string
  threads_biography?: string
  threads_profile_picture_url?: string
}

/** Статус контейнера публикации. */
export type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED"

export interface ContainerState {
  status: ContainerStatus
  error_message?: string
}

/** Опубликованный пост. */
export interface ThreadsPost {
  id: string
  text?: string
  permalink?: string
  timestamp?: string
  media_type?: string
  username?: string
  /** Заполняется для ответов: id корневого поста беседы */
  root_post?: { id: string }
  replied_to?: { id: string }
  is_reply?: boolean
  hide_status?: string
}

/** Квоты публикации за последние 24 часа. */
export interface PublishingLimit {
  postsUsed: number
  postsTotal: number
  repliesUsed: number
  repliesTotal: number
}

/** Метрики поста или аккаунта. */
export interface InsightMetric {
  name: string
  period?: string
  values?: Array<{ value: number }>
  total_value?: { value: number }
  title?: string
}

/** Что публикуем — единое описание для всех типов постов. */
export interface PublishInput {
  text?: string
  imageUrl?: string
  videoUrl?: string
  /** Для карусели: id заранее созданных дочерних контейнеров */
  children?: string[]
  /** Если задан — публикуем как ответ на этот пост */
  replyToId?: string
  /** Ограничение, кто может отвечать */
  replyControl?: "everyone" | "accounts_you_follow" | "mentioned_only"
}

/** Элемент очереди отложенных публикаций. */
export interface QueueItem {
  id: string
  text?: string
  imageUrl?: string
  videoUrl?: string
  replyToId?: string
  /** ISO-время, когда пост должен уйти */
  publishAt: string
  status: "pending" | "published" | "failed" | "canceled"
  attempts: number
  lastError?: string
  publishedPostId?: string
  createdAt: string
}

/** Правило автоответа на комментарии. */
export interface ReplyRule {
  /** Регулярное выражение (строкой), проверяется без учёта регистра */
  pattern: string
  /** Варианты ответа — выбирается случайный, чтобы не выглядеть шаблонно */
  responses: string[]
  /** Не отвечать, если автор ответа — ты сам */
  skipOwnReplies?: boolean
}

export interface AutoReplyConfig {
  rules: ReplyRule[]
  /** Максимум автоответов за один прогон — страховка от лавины */
  maxPerRun: number
}
