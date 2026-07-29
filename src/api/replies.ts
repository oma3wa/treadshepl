/**
 * Работа с ответами: чтение, автоответ по правилам, скрытие.
 *
 * Автоответ — самая рискованная часть бота: шаблонные ответы выглядят
 * как спам. Поэтому здесь предусмотрены варианты формулировок,
 * лимит ответов за прогон и журнал, чтобы не отвечать дважды.
 */

import { request, get } from "./client.js"
import { publish } from "./publish.js"
import { log } from "../lib/logger.js"
import type { AutoReplyConfig, ThreadsPost } from "../types.js"

interface Paged<T> {
  data: T[]
  paging?: { cursors?: { before?: string; after?: string }; next?: string }
}

const POST_FIELDS = ["id", "text", "username", "timestamp", "permalink", "replied_to", "root_post", "hide_status"]

/** Ответы на конкретный пост. */
export async function getReplies(postId: string, token: string): Promise<ThreadsPost[]> {
  const res = await request<Paged<ThreadsPost>>(`/${postId}/replies`, {
    method: "GET",
    token,
    params: { fields: POST_FIELDS.join(","), limit: 50 },
  })
  return res.data ?? []
}

/** Вся беседа под постом, включая вложенные ответы. */
export async function getConversation(postId: string, token: string): Promise<ThreadsPost[]> {
  const res = await request<Paged<ThreadsPost>>(`/${postId}/conversation`, {
    method: "GET",
    token,
    params: { fields: POST_FIELDS.join(","), limit: 50 },
  })
  return res.data ?? []
}

/** Скрывает или возвращает ответ. */
export async function setReplyHidden(replyId: string, token: string, hide: boolean): Promise<void> {
  await request(`/${replyId}/manage_reply`, { method: "POST", token, params: { hide } })
  log.ok(hide ? `Ответ ${replyId} скрыт` : `Ответ ${replyId} снова виден`)
}

/** Последние посты пользователя — источник для поиска новых ответов. */
export async function getUserPosts(userId: string, token: string, limit = 10): Promise<ThreadsPost[]> {
  const res = await request<Paged<ThreadsPost>>(`/${userId}/threads`, {
    method: "GET",
    token,
    params: { fields: ["id", "text", "permalink", "timestamp"].join(","), limit },
  })
  return res.data ?? []
}

/** Первое подходящее правило для текста ответа. */
export function matchRule(text: string, cfg: AutoReplyConfig): string | undefined {
  for (const rule of cfg.rules) {
    let re: RegExp
    try {
      re = new RegExp(rule.pattern, "i")
    } catch {
      log.warn(`Некорректное регулярное выражение в правиле: ${rule.pattern}`)
      continue
    }
    if (re.test(text) && rule.responses.length > 0) {
      // Случайный вариант, чтобы ответы не выглядели одинаково
      const pick = rule.responses[Math.floor(Math.random() * rule.responses.length)]
      if (pick) return pick
    }
  }
  return undefined
}

export interface AutoReplyResult {
  checked: number
  replied: number
  skipped: number
}

/**
 * Проходит по ответам на последние посты и отвечает по правилам.
 *
 * Никогда не отвечает сам себе и не отвечает дважды на один и тот же
 * комментарий — иначе бот устроит бесконечную переписку с собой.
 */
export async function runAutoReply(
  userId: string,
  token: string,
  cfg: AutoReplyConfig,
  alreadyReplied: Set<string>,
  options: { dryRun?: boolean; postsToScan?: number } = {},
): Promise<AutoReplyResult> {
  const { dryRun = false, postsToScan = 5 } = options
  const me = await get<{ username?: string }>(`/${userId}`, token, ["username"])
  const myUsername = me.username

  const posts = await getUserPosts(userId, token, postsToScan)
  const result: AutoReplyResult = { checked: 0, replied: 0, skipped: 0 }

  for (const post of posts) {
    const replies = await getReplies(post.id, token)

    for (const reply of replies) {
      result.checked++

      if (reply.username && myUsername && reply.username === myUsername) {
        result.skipped++
        continue
      }
      if (alreadyReplied.has(reply.id)) {
        result.skipped++
        continue
      }
      if (result.replied >= cfg.maxPerRun) {
        log.warn(`Достигнут лимит ${cfg.maxPerRun} автоответов за прогон — остальные пропущены`)
        return result
      }

      const response = matchRule(reply.text ?? "", cfg)
      if (!response) {
        result.skipped++
        continue
      }

      if (dryRun) {
        log.info(`[черновой прогон] @${reply.username ?? "?"}: "${(reply.text ?? "").slice(0, 60)}" → "${response}"`)
      } else {
        await publish(userId, token, { text: response, replyToId: reply.id })
        log.ok(`Ответил @${reply.username ?? "?"}`)
      }
      alreadyReplied.add(reply.id)
      result.replied++
    }
  }
  return result
}
