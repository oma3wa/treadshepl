/**
 * Обработчик очереди — «сердце» отложенных публикаций.
 *
 * Команда tick рассчитана на запуск по cron каждые несколько минут.
 * Она сама себя защищает: проверяет остаток квоты, ограничивает число
 * публикаций за прогон и помечает неудачи, чтобы не долбить API вечно.
 */

import { publish } from "../api/publish.js"
import { getPublishingLimit } from "../api/insights.js"
import { loadToken } from "../store/tokens.js"
import { dueItems, updateItem, MAX_ATTEMPTS } from "../store/queue.js"
import { ApiError } from "../lib/errors.js"
import { log } from "../lib/logger.js"

export interface TickResult {
  due: number
  published: number
  failed: number
  postponed: number
}

/**
 * Публикует всё, чему пришло время.
 *
 * @param maxPerRun страховка: даже если очередь забита, за один прогон
 *   уйдёт не больше указанного числа постов — так лента не превратится в спам.
 */
export async function tick(options: { maxPerRun?: number; dryRun?: boolean } = {}): Promise<TickResult> {
  const { maxPerRun = 5, dryRun = false } = options
  const { accessToken: token, userId } = loadToken()

  const items = dueItems()
  const result: TickResult = { due: items.length, published: 0, failed: 0, postponed: 0 }

  if (items.length === 0) {
    log.info("Очередь пуста — публиковать нечего")
    return result
  }
  log.info(`К публикации готово записей: ${items.length}`)

  // Проверяем квоту заранее: упереться в лимит на середине пачки неприятно
  const limit = await getPublishingLimit(userId, token)
  const remaining = limit.postsTotal - limit.postsUsed
  log.step(`Квота публикаций: использовано ${limit.postsUsed} из ${limit.postsTotal}, осталось ${remaining}`)

  if (remaining <= 0) {
    log.warn("Суточная квота публикаций исчерпана — записи остаются в очереди")
    result.postponed = items.length
    return result
  }

  const budget = Math.min(maxPerRun, remaining, items.length)
  if (budget < items.length) {
    result.postponed = items.length - budget
    log.info(`За этот прогон будет опубликовано ${budget}, остальное — в следующий раз`)
  }

  for (const item of items.slice(0, budget)) {
    if (dryRun) {
      log.info(`[черновой прогон] ${item.id}: "${(item.text ?? "медиа").slice(0, 60)}"`)
      result.published++
      continue
    }

    try {
      const post = await publish(userId, token, {
        text: item.text,
        imageUrl: item.imageUrl,
        videoUrl: item.videoUrl,
        replyToId: item.replyToId,
      })
      updateItem(item.id, { status: "published", publishedPostId: post.id, attempts: item.attempts + 1 })
      result.published++
    } catch (error) {
      const attempts = item.attempts + 1
      const message = error instanceof Error ? error.message : String(error)

      // Ошибку, которую есть смысл повторить, оставляем в очереди
      const retryable = error instanceof ApiError && error.retryable
      const exhausted = attempts >= MAX_ATTEMPTS

      updateItem(item.id, {
        attempts,
        lastError: message,
        status: !retryable || exhausted ? "failed" : "pending",
      })

      if (!retryable || exhausted) {
        result.failed++
        log.error(`Запись ${item.id} не опубликована (попыток: ${attempts}): ${message}`)
      } else {
        result.postponed++
        log.warn(`Запись ${item.id} отложена до следующего прогона: ${message}`)
      }
    }
  }

  log.ok(
    `Итог: опубликовано ${result.published}, отложено ${result.postponed}, с ошибкой ${result.failed}`,
  )
  return result
}
