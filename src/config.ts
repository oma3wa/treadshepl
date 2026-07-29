/**
 * Конфигурация из переменных окружения.
 *
 * .env читается вручную простым парсером, чтобы не тянуть dotenv:
 * у проекта принципиально ноль рантайм-зависимостей.
 */

import { readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { BotError } from "./lib/errors.js"

/** Корень проекта: на уровень выше dist/ или src/ */
export const PROJECT_ROOT = resolve(import.meta.dirname, "..")

/** Каталог для локальных данных: токен, очередь, журнал автоответов. */
export const DATA_DIR = process.env.THREADS_DATA_DIR ?? join(PROJECT_ROOT, "data")

/** Минимальный парсер .env: KEY=VALUE, поддержка кавычек и комментариев. */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    // Переменные, уже заданные в окружении, приоритетнее файла
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadDotEnv(join(PROJECT_ROOT, ".env"))

export interface Config {
  appId?: string
  appSecret?: string
  redirectUri?: string
  /** Хост Graph API. Meta документировала и .net, и .com — оставлено настраиваемым. */
  graphHost: string
  /** Хост страницы авторизации. */
  authHost: string
  apiVersion: string
  /** Пауза между запросами, мс — страховка от троттлинга. */
  throttleMs: number
}

export const config: Config = {
  appId: process.env.THREADS_APP_ID,
  appSecret: process.env.THREADS_APP_SECRET,
  redirectUri: process.env.THREADS_REDIRECT_URI,
  graphHost: process.env.THREADS_GRAPH_HOST ?? "https://graph.threads.net",
  authHost: process.env.THREADS_AUTH_HOST ?? "https://threads.net",
  apiVersion: process.env.THREADS_API_VERSION ?? "v1.0",
  throttleMs: Number(process.env.THREADS_THROTTLE_MS ?? 250),
}

/** Проверяет, что заданы переменные, нужные для OAuth. */
export function requireOAuthConfig(): Required<Pick<Config, "appId" | "appSecret" | "redirectUri">> {
  const missing: string[] = []
  if (!config.appId) missing.push("THREADS_APP_ID")
  if (!config.appSecret) missing.push("THREADS_APP_SECRET")
  if (!config.redirectUri) missing.push("THREADS_REDIRECT_URI")

  if (missing.length > 0) {
    throw new BotError(
      `Не заданы переменные окружения: ${missing.join(", ")}`,
      "Скопируй .env.example в .env и заполни значениями из настроек приложения на developers.facebook.com",
    )
  }
  return { appId: config.appId!, appSecret: config.appSecret!, redirectUri: config.redirectUri! }
}
