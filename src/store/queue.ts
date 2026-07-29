/**
 * Очередь отложенных публикаций.
 *
 * Threads API не умеет планировать посты на будущее — нет ни
 * scheduled_publish_time, ни черновиков. Поэтому расписание держим у себя:
 * запись лежит в JSON, а команда `tick` (её вешают на cron) публикует всё,
 * чему пришло время.
 *
 * Файл, а не база: для личного бота этого достаточно, а зависимостей ноль.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { DATA_DIR } from "../config.js"
import { BotError } from "../lib/errors.js"
import type { QueueItem } from "../types.js"

const QUEUE_PATH = join(DATA_DIR, "queue.json")
const REPLIED_PATH = join(DATA_DIR, "replied.json")

/** Сколько раз пытаемся опубликовать запись, прежде чем признать её неудачной. */
export const MAX_ATTEMPTS = 3

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
}

export function readQueue(): QueueItem[] {
  if (!existsSync(QUEUE_PATH)) return []
  return JSON.parse(readFileSync(QUEUE_PATH, "utf8")) as QueueItem[]
}

export function writeQueue(items: QueueItem[]): void {
  ensureDataDir()
  writeFileSync(QUEUE_PATH, JSON.stringify(items, null, 2))
}

export interface EnqueueInput {
  text?: string
  imageUrl?: string
  videoUrl?: string
  replyToId?: string
  publishAt: Date
}

export function enqueue(input: EnqueueInput): QueueItem {
  if (Number.isNaN(input.publishAt.getTime())) {
    throw new BotError(
      "Не удалось разобрать дату публикации",
      'Формат: "2026-08-01 09:30" или ISO "2026-08-01T09:30:00"',
    )
  }

  const item: QueueItem = {
    id: randomUUID().slice(0, 8),
    text: input.text,
    imageUrl: input.imageUrl,
    videoUrl: input.videoUrl,
    replyToId: input.replyToId,
    publishAt: input.publishAt.toISOString(),
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
  }

  const items = readQueue()
  items.push(item)
  items.sort((a, b) => a.publishAt.localeCompare(b.publishAt))
  writeQueue(items)
  return item
}

/** Записи, которым пора публиковаться. */
export function dueItems(now: Date = new Date()): QueueItem[] {
  return readQueue().filter(
    (item) => item.status === "pending" && item.attempts < MAX_ATTEMPTS && new Date(item.publishAt) <= now,
  )
}

export function updateItem(id: string, patch: Partial<QueueItem>): void {
  const items = readQueue()
  const index = items.findIndex((i) => i.id === id)
  if (index === -1) throw new BotError(`Запись очереди ${id} не найдена`)
  items[index] = { ...items[index]!, ...patch }
  writeQueue(items)
}

export function cancelItem(id: string): void {
  updateItem(id, { status: "canceled" })
}

/** Удаляет опубликованные и отменённые записи, оставляя историю компактной. */
export function pruneQueue(): number {
  const items = readQueue()
  const keep = items.filter((i) => i.status === "pending" || i.status === "failed")
  writeQueue(keep)
  return items.length - keep.length
}

// ─── журнал автоответов: на какие комментарии уже ответили ───

export function readRepliedIds(): Set<string> {
  if (!existsSync(REPLIED_PATH)) return new Set()
  return new Set(JSON.parse(readFileSync(REPLIED_PATH, "utf8")) as string[])
}

export function writeRepliedIds(ids: Set<string>): void {
  ensureDataDir()
  // Храним последние 5000 — иначе файл будет расти бесконечно
  const trimmed = [...ids].slice(-5000)
  writeFileSync(REPLIED_PATH, JSON.stringify(trimmed, null, 2))
}

/**
 * Разбирает дату из аргумента командной строки.
 * Понимает ISO, "YYYY-MM-DD HH:mm" и относительные "+30m", "+2h", "+1d".
 */
export function parseWhen(input: string): Date {
  const relative = /^\+(\d+)([mhd])$/.exec(input.trim())
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2]
    const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
    return new Date(Date.now() + amount * ms)
  }
  // "2026-08-01 09:30" → добавляем T, чтобы Date разобрал как локальное время
  const normalized = input.includes("T") ? input : input.replace(" ", "T")
  return new Date(normalized)
}
