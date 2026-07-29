#!/usr/bin/env node
/**
 * Командный интерфейс бота.
 *
 * Все команды перечислены в HELP ниже. Ошибки перехватываются в одном месте,
 * чтобы пользователь видел понятное сообщение с подсказкой, а не стек вызовов.
 */

import { readFileSync, existsSync } from "node:fs"
import { buildAuthUrl, exchangeCode, refreshToken } from "./api/auth.js"
import { get } from "./api/client.js"
import { publish, publishThread, splitIntoParts, createCarouselItem, waitForContainer, publishContainer, MAX_TEXT_LENGTH } from "./api/publish.js"
import { getPostInsights, getUserInsights, getPublishingLimit } from "./api/insights.js"
import { getReplies, getConversation, setReplyHidden, getUserPosts, runAutoReply } from "./api/replies.js"
import { loadToken, daysUntilExpiry } from "./store/tokens.js"
import {
  enqueue,
  readQueue,
  cancelItem,
  pruneQueue,
  parseWhen,
  readRepliedIds,
  writeRepliedIds,
} from "./store/queue.js"
import { tick } from "./commands/scheduler.js"
import { BotError } from "./lib/errors.js"
import { log } from "./lib/logger.js"
import type { AutoReplyConfig, ThreadsProfile } from "./types.js"

const HELP = `
Бот для Threads на официальном API

  АВТОРИЗАЦИЯ
    login                        Ссылка для авторизации приложения
    exchange <code>              Обменять код на токен (60 дней)
    refresh                      Продлить токен ещё на 60 дней
    whoami                       Профиль и срок действия токена

  ПУБЛИКАЦИЯ
    post <текст>                 Текстовый пост
    post-image <текст> <url>     Пост с картинкой
    post-video <текст> <url>     Пост с видео
    carousel <текст> <url...>    Карусель из 2-20 медиа
    thread <текст>               Длинный текст цепочкой постов
    reply <id> <текст>           Ответить на пост

  ОТЛОЖЕННЫЕ ПОСТЫ
    schedule <когда> <текст>     Добавить в очередь
                                 когда: "2026-08-01 09:30" или +30m / +2h / +1d
    queue                        Показать очередь
    cancel <id>                  Отменить запись
    prune                        Убрать опубликованные из очереди
    tick [--dry-run]             Опубликовать всё, чему пришло время (для cron)

  ОТВЕТЫ
    posts [n]                    Последние посты
    replies <id>                 Ответы на пост
    conversation <id>            Вся беседа под постом
    hide <reply-id>              Скрыть ответ
    unhide <reply-id>            Вернуть ответ
    autoreply [--dry-run]        Автоответы по правилам из autoreply.json

  АНАЛИТИКА
    limits                       Остаток суточных квот
    stats <post-id>              Метрики поста
    stats-account                Метрики аккаунта за 30 дней

  Флаги: --dry-run (ничего не публиковать), --debug (подробный вывод)
`

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith("--")))
const positional = args.filter((a) => !a.startsWith("--"))
const [command, ...rest] = positional

if (flags.has("--debug")) process.env.THREADS_BOT_DEBUG = "1"
const dryRun = flags.has("--dry-run")

/** Требует, чтобы аргумент был передан, иначе — понятная ошибка. */
function required(value: string | undefined, name: string, example: string): string {
  if (!value) throw new BotError(`Не указан аргумент: ${name}`, `Пример: npm run bot -- ${example}`)
  return value
}

function loadAutoReplyConfig(): AutoReplyConfig {
  const path = "autoreply.json"
  if (!existsSync(path)) {
    throw new BotError(
      "Файл autoreply.json не найден",
      "Скопируй autoreply.example.json в autoreply.json и опиши свои правила",
    )
  }
  return JSON.parse(readFileSync(path, "utf8")) as AutoReplyConfig
}

async function main(): Promise<void> {
  switch (command) {
    case undefined:
    case "help":
    case "--help":
      console.log(HELP)
      return

    // ─── авторизация ───

    case "login": {
      // Сначала собираем ссылку: если конфига нет, пользователь получит
      // ошибку сразу, а не после вводного текста
      const url = buildAuthUrl()
      log.info("\nОткрой ссылку, разреши доступ, затем скопируй значение ?code= из адресной строки:\n")
      log.info(url)
      log.info("\nДалее: npm run bot -- exchange <code>\n")
      return
    }

    case "exchange": {
      await exchangeCode(required(rest[0], "code", 'exchange "AQD..."'))
      log.info("Готово. Проверь: npm run bot -- whoami")
      return
    }

    case "refresh": {
      await refreshToken()
      return
    }

    case "whoami": {
      const token = loadToken()
      const profile = await get<ThreadsProfile>(`/${token.userId}`, token.accessToken, [
        "id",
        "username",
        "threads_biography",
      ])
      log.info(`@${profile.username ?? "?"} (id ${profile.id})`)
      if (profile.threads_biography) log.info(profile.threads_biography)
      log.info(`Токен действует ещё ${daysUntilExpiry(token)} дн.`)
      return
    }

    // ─── публикация ───

    case "post": {
      const { accessToken, userId } = loadToken()
      await publish(userId, accessToken, { text: required(rest[0], "текст", 'post "Привет"') })
      return
    }

    case "post-image": {
      const { accessToken, userId } = loadToken()
      const text = required(rest[0], "текст", 'post-image "текст" https://…/pic.jpg')
      const url = required(rest[1], "url картинки", 'post-image "текст" https://…/pic.jpg')
      await publish(userId, accessToken, { text, imageUrl: url })
      return
    }

    case "post-video": {
      const { accessToken, userId } = loadToken()
      const text = required(rest[0], "текст", 'post-video "текст" https://…/clip.mp4')
      const url = required(rest[1], "url видео", 'post-video "текст" https://…/clip.mp4')
      log.info("Видео обрабатывается на стороне Meta — это может занять до минуты")
      await publish(userId, accessToken, { text, videoUrl: url })
      return
    }

    case "carousel": {
      const { accessToken, userId } = loadToken()
      const text = required(rest[0], "текст", 'carousel "текст" url1 url2')
      const urls = rest.slice(1)
      if (urls.length < 2 || urls.length > 20) {
        throw new BotError(`Карусель — от 2 до 20 медиа (передано ${urls.length})`)
      }
      log.step(`Создаю ${urls.length} дочерних контейнеров`)
      const children: string[] = []
      for (const url of urls) {
        const isVideo = /\.(mp4|mov|webm)(\?|$)/i.test(url)
        const id = await createCarouselItem(userId, accessToken, isVideo ? { videoUrl: url } : { imageUrl: url })
        children.push(id)
      }
      for (const child of children) await waitForContainer(child, accessToken)
      await publish(userId, accessToken, { text, children })
      return
    }

    case "thread": {
      const { accessToken, userId } = loadToken()
      const text = required(rest[0], "текст", 'thread "длинный текст…"')
      const parts = splitIntoParts(text)
      log.info(`Текст разбит на ${parts.length} ч. (лимит ${MAX_TEXT_LENGTH} символов на пост)`)
      await publishThread(userId, accessToken, parts)
      return
    }

    case "reply": {
      const { accessToken, userId } = loadToken()
      const postId = required(rest[0], "id поста", 'reply 123456 "ответ"')
      const text = required(rest[1], "текст", 'reply 123456 "ответ"')
      await publish(userId, accessToken, { text, replyToId: postId })
      return
    }

    // ─── очередь ───

    case "schedule": {
      const when = required(rest[0], "когда", 'schedule "+2h" "текст поста"')
      const text = required(rest[1], "текст", 'schedule "+2h" "текст поста"')
      const item = enqueue({ text, publishAt: parseWhen(when) })
      log.ok(`В очереди ${item.id}: ${new Date(item.publishAt).toLocaleString("ru-RU")}`)
      return
    }

    case "queue": {
      const items = readQueue()
      if (items.length === 0) {
        log.info("Очередь пуста")
        return
      }
      const icon = { pending: "⏳", published: "✓", failed: "✗", canceled: "—" } as const
      for (const item of items) {
        const when = new Date(item.publishAt).toLocaleString("ru-RU")
        log.info(
          `${icon[item.status]} ${item.id}  ${when}  ${(item.text ?? "(медиа)").slice(0, 50)}` +
            (item.lastError ? `\n     ошибка: ${item.lastError}` : ""),
        )
      }
      return
    }

    case "cancel": {
      cancelItem(required(rest[0], "id записи", "cancel a1b2c3d4"))
      log.ok("Запись отменена")
      return
    }

    case "prune": {
      log.ok(`Убрано записей: ${pruneQueue()}`)
      return
    }

    case "tick": {
      await tick({ dryRun })
      return
    }

    // ─── ответы ───

    case "posts": {
      const { accessToken, userId } = loadToken()
      const posts = await getUserPosts(userId, accessToken, Number(rest[0] ?? 10))
      for (const p of posts) {
        log.info(`${p.id}  ${p.timestamp ?? ""}  ${(p.text ?? "").slice(0, 60)}`)
      }
      return
    }

    case "replies": {
      const { accessToken } = loadToken()
      const replies = await getReplies(required(rest[0], "id поста", "replies 123456"), accessToken)
      if (replies.length === 0) log.info("Ответов нет")
      for (const r of replies) {
        log.info(`${r.id}  @${r.username ?? "?"}  ${(r.text ?? "").slice(0, 70)}`)
      }
      return
    }

    case "conversation": {
      const { accessToken } = loadToken()
      const items = await getConversation(required(rest[0], "id поста", "conversation 123456"), accessToken)
      for (const r of items) log.info(`${r.id}  @${r.username ?? "?"}  ${(r.text ?? "").slice(0, 70)}`)
      return
    }

    case "hide":
    case "unhide": {
      const { accessToken } = loadToken()
      await setReplyHidden(required(rest[0], "id ответа", `${command} 123456`), accessToken, command === "hide")
      return
    }

    case "autoreply": {
      const { accessToken, userId } = loadToken()
      const cfg = loadAutoReplyConfig()
      const replied = readRepliedIds()
      const result = await runAutoReply(userId, accessToken, cfg, replied, { dryRun })
      if (!dryRun) writeRepliedIds(replied)
      log.ok(`Проверено ${result.checked}, ответов ${result.replied}, пропущено ${result.skipped}`)
      return
    }

    // ─── аналитика ───

    case "limits": {
      const { accessToken, userId } = loadToken()
      const l = await getPublishingLimit(userId, accessToken)
      log.info(`Посты:  ${l.postsUsed} / ${l.postsTotal} за 24 ч`)
      log.info(`Ответы: ${l.repliesUsed} / ${l.repliesTotal} за 24 ч`)
      return
    }

    case "stats": {
      const { accessToken } = loadToken()
      const metrics = await getPostInsights(required(rest[0], "id поста", "stats 123456"), accessToken)
      for (const [name, value] of Object.entries(metrics)) log.info(`${name.padEnd(10)} ${value}`)
      return
    }

    case "stats-account": {
      const { accessToken, userId } = loadToken()
      const since = new Date(Date.now() - 30 * 86_400_000)
      const metrics = await getUserInsights(userId, accessToken, { since })
      for (const [name, value] of Object.entries(metrics)) log.info(`${name.padEnd(16)} ${value}`)
      return
    }

    default:
      throw new BotError(`Неизвестная команда: ${command}`, "Список команд: npm run bot -- help")
  }
}

main().catch((error: unknown) => {
  if (error instanceof BotError) {
    log.error(error.message)
    if (error.hint) log.info(`  → ${error.hint}`)
  } else {
    log.error(error instanceof Error ? error.message : String(error))
    if (process.env.THREADS_BOT_DEBUG === "1" && error instanceof Error) {
      console.error(error.stack)
    } else {
      log.info("  → Подробности: добавь флаг --debug")
    }
  }
  process.exit(1)
})
