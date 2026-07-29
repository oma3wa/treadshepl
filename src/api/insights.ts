/**
 * Аналитика: метрики постов и аккаунта.
 *
 * У Threads короткое окно ретроспективы, поэтому исторические значения
 * стоит складывать у себя — API не отдаст данные за давние периоды.
 */

import { request } from "./client.js"
import type { InsightMetric, PublishingLimit } from "../types.js"

interface InsightsResponse {
  data: InsightMetric[]
}

/** Метрики уровня поста. */
export const POST_METRICS = ["views", "likes", "replies", "reposts", "quotes", "shares"] as const

/** Метрики уровня аккаунта. */
export const USER_METRICS = ["views", "likes", "replies", "reposts", "quotes", "followers_count"] as const

/** Простое число из метрики: API отдаёт значение то в total_value, то в values[]. */
function metricValue(metric: InsightMetric): number {
  if (metric.total_value?.value !== undefined) return metric.total_value.value
  return metric.values?.reduce((sum, v) => sum + (v.value ?? 0), 0) ?? 0
}

export async function getPostInsights(postId: string, token: string): Promise<Record<string, number>> {
  const res = await request<InsightsResponse>(`/${postId}/insights`, {
    method: "GET",
    token,
    params: { metric: POST_METRICS.join(",") },
  })
  return Object.fromEntries((res.data ?? []).map((m) => [m.name, metricValue(m)]))
}

export async function getUserInsights(
  userId: string,
  token: string,
  options: { since?: Date; until?: Date } = {},
): Promise<Record<string, number>> {
  const res = await request<InsightsResponse>(`/${userId}/threads_insights`, {
    method: "GET",
    token,
    params: {
      metric: USER_METRICS.join(","),
      since: options.since ? Math.floor(options.since.getTime() / 1000) : undefined,
      until: options.until ? Math.floor(options.until.getTime() / 1000) : undefined,
    },
  })
  return Object.fromEntries((res.data ?? []).map((m) => [m.name, metricValue(m)]))
}

interface LimitResponse {
  data: Array<{
    quota_usage?: number
    config?: { quota_total?: number; quota_duration?: number }
    reply_quota_usage?: number
    reply_config?: { quota_total?: number }
  }>
}

/**
 * Сколько публикаций и ответов израсходовано за последние 24 часа.
 * Стоит проверять перед пакетной публикацией, чтобы не упереться в лимит.
 */
export async function getPublishingLimit(userId: string, token: string): Promise<PublishingLimit> {
  const res = await request<LimitResponse>(`/${userId}/threads_publishing_limit`, {
    method: "GET",
    token,
    params: { fields: "quota_usage,config,reply_quota_usage,reply_config" },
  })
  const d = res.data?.[0] ?? {}
  return {
    postsUsed: d.quota_usage ?? 0,
    postsTotal: d.config?.quota_total ?? 250,
    repliesUsed: d.reply_quota_usage ?? 0,
    repliesTotal: d.reply_config?.quota_total ?? 1000,
  }
}
