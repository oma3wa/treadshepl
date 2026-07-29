/**
 * Публикация в Threads.
 *
 * API не умеет публиковать одним запросом — всегда два шага:
 *   1) POST /{user-id}/threads          → создаётся контейнер
 *   2) POST /{user-id}/threads_publish  → контейнер публикуется
 *
 * Между шагами контейнер должен перейти в статус FINISHED. Документация
 * советует «подождать 30 секунд», но это плохой совет: для текста готово
 * почти сразу, а видео может обрабатываться дольше 30 секунд. Поэтому
 * здесь опрос статуса, а не фиксированная пауза.
 */

import { request, get, sleep } from "./client.js"
import { BotError } from "../lib/errors.js"
import { log } from "../lib/logger.js"
import type { ContainerState, MediaType, PublishInput, ThreadsPost } from "../types.js"

/** Лимит символов в посте Threads. */
export const MAX_TEXT_LENGTH = 500

interface CreatedContainer {
  id: string
}

function detectMediaType(input: PublishInput): MediaType {
  if (input.children && input.children.length > 0) return "CAROUSEL"
  if (input.videoUrl) return "VIDEO"
  if (input.imageUrl) return "IMAGE"
  return "TEXT"
}

function validate(input: PublishInput): void {
  const hasMedia = Boolean(input.imageUrl ?? input.videoUrl ?? input.children?.length)
  if (!input.text && !hasMedia) {
    throw new BotError("Нечего публиковать", "Укажи текст или медиа")
  }
  if (input.text && input.text.length > MAX_TEXT_LENGTH) {
    throw new BotError(
      `Текст длиннее ${MAX_TEXT_LENGTH} символов (сейчас ${input.text.length})`,
      "Сократи текст или разбей на цепочку постов командой thread",
    )
  }
  if (input.imageUrl && input.videoUrl) {
    throw new BotError("Нельзя одновременно image_url и video_url", "Для нескольких медиа используй карусель")
  }
  for (const url of [input.imageUrl, input.videoUrl]) {
    if (url && !url.startsWith("https://")) {
      throw new BotError(
        `URL медиа должен начинаться с https:// (получено: ${url.slice(0, 40)})`,
        "Meta скачивает файл сама, поэтому ссылка должна быть публичной и по HTTPS",
      )
    }
  }
}

/** Создаёт контейнер публикации и возвращает его id. */
export async function createContainer(userId: string, token: string, input: PublishInput): Promise<string> {
  validate(input)
  const mediaType = detectMediaType(input)

  const { id } = await request<CreatedContainer>(`/${userId}/threads`, {
    method: "POST",
    token,
    params: {
      media_type: mediaType,
      text: input.text,
      image_url: input.imageUrl,
      video_url: input.videoUrl,
      children: input.children?.join(","),
      reply_to_id: input.replyToId,
      reply_control: input.replyControl,
    },
  })
  log.step(`Контейнер ${mediaType} создан: ${id}`)
  return id
}

/** Создаёт дочерний контейнер для карусели (is_carousel_item=true, без публикации). */
export async function createCarouselItem(
  userId: string,
  token: string,
  media: { imageUrl?: string; videoUrl?: string },
): Promise<string> {
  if (!media.imageUrl && !media.videoUrl) {
    throw new BotError("Для элемента карусели нужен imageUrl или videoUrl")
  }
  const { id } = await request<CreatedContainer>(`/${userId}/threads`, {
    method: "POST",
    token,
    params: {
      media_type: media.videoUrl ? "VIDEO" : "IMAGE",
      image_url: media.imageUrl,
      video_url: media.videoUrl,
      is_carousel_item: true,
    },
  })
  return id
}

/**
 * Ждёт, пока контейнер станет FINISHED.
 *
 * Интервал растёт от 2 до 8 секунд: быстрый отклик для текста и картинок,
 * без лишних запросов при долгой обработке видео.
 */
export async function waitForContainer(
  containerId: string,
  token: string,
  { maxAttempts = 30 }: { maxAttempts?: number } = {},
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const state = await get<ContainerState>(`/${containerId}`, token, ["status", "error_message"])

    if (state.status === "FINISHED" || state.status === "PUBLISHED") return

    if (state.status === "ERROR" || state.status === "EXPIRED") {
      throw new BotError(
        `Контейнер в статусе ${state.status}: ${state.error_message ?? "детали не указаны"}`,
        state.status === "EXPIRED"
          ? "Контейнер живёт 24 часа — создай публикацию заново"
          : "Чаще всего причина в недоступном URL медиа или неподдерживаемом формате",
      )
    }

    log.debug(`Статус контейнера: ${state.status} (попытка ${attempt}/${maxAttempts})`)
    await sleep(Math.min(2000 + attempt * 400, 8000))
  }

  throw new BotError(
    "Контейнер не готов после всех попыток",
    "Обработка медиа затянулась. Контейнер живёт 24 часа — можно опубликовать позже командой publish-container",
  )
}

/** Публикует готовый контейнер и возвращает id поста. */
export async function publishContainer(userId: string, token: string, containerId: string): Promise<string> {
  const { id } = await request<CreatedContainer>(`/${userId}/threads_publish`, {
    method: "POST",
    token,
    params: { creation_id: containerId },
  })
  return id
}

/** Полный цикл публикации: контейнер → ожидание → публикация → ссылка на пост. */
export async function publish(userId: string, token: string, input: PublishInput): Promise<ThreadsPost> {
  const containerId = await createContainer(userId, token, input)
  await waitForContainer(containerId, token)
  const postId = await publishContainer(userId, token, containerId)

  const post = await get<ThreadsPost>(`/${postId}`, token, ["id", "permalink", "text", "timestamp"])
  log.ok(`Опубликовано: ${post.permalink ?? postId}`)
  return post
}

/**
 * Публикует цепочку постов: каждый следующий — ответ на предыдущий.
 * Так обходится лимит 500 символов для длинных текстов.
 */
export async function publishThread(
  userId: string,
  token: string,
  parts: string[],
  options: { replyControl?: PublishInput["replyControl"] } = {},
): Promise<ThreadsPost[]> {
  if (parts.length === 0) throw new BotError("Нет частей для публикации")

  const posts: ThreadsPost[] = []
  let replyToId: string | undefined

  for (const [index, text] of parts.entries()) {
    log.step(`Часть ${index + 1} из ${parts.length}`)
    const post = await publish(userId, token, {
      text,
      replyToId,
      replyControl: index === 0 ? options.replyControl : undefined,
    })
    posts.push(post)
    replyToId = post.id
  }
  return posts
}

/** Разбивает длинный текст на части по границам предложений/слов. */
export function splitIntoParts(text: string, limit = MAX_TEXT_LENGTH): string[] {
  if (text.length <= limit) return [text]

  const parts: string[] = []
  let rest = text.trim()

  while (rest.length > limit) {
    // Ищем последнюю границу предложения, иначе — последний пробел
    const window = rest.slice(0, limit)
    const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "))
    const cut = sentenceEnd > limit * 0.5 ? sentenceEnd + 1 : window.lastIndexOf(" ")
    const safeCut = cut > 0 ? cut : limit

    parts.push(rest.slice(0, safeCut).trim())
    rest = rest.slice(safeCut).trim()
  }
  if (rest.length > 0) parts.push(rest)
  return parts
}
