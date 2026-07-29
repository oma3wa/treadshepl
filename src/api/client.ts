/**
 * Низкоуровневый HTTP-клиент Graph API.
 *
 * Отвечает за: сборку URL, передачу токена, разбор ошибок Meta,
 * повторы при троттлинге и 5xx, паузы между запросами.
 */

import { config } from "../config.js"
import { ApiError, hintForCode } from "../lib/errors.js"
import { log } from "../lib/logger.js"

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE"
  /** Параметры запроса: в GET уходят в query, в POST — в тело формы */
  params?: Record<string, string | number | boolean | undefined>
  token?: string
  /** Сколько раз повторить при ошибке, которую есть смысл повторять */
  retries?: number
  /** Абсолютный URL вместо сборки из graphHost + версия */
  absoluteUrl?: string
}

let lastRequestAt = 0

/** Держит минимальную паузу между запросами, чтобы не влететь в лимит частоты. */
async function throttle(): Promise<void> {
  const wait = config.throttleMs - (Date.now() - lastRequestAt)
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

interface MetaErrorBody {
  error?: {
    message?: string
    type?: string
    code?: number
    error_subcode?: number
    fbtrace_id?: string
  }
}

/**
 * Выполняет запрос к Graph API.
 *
 * Токен всегда передаётся как параметр (так требует Graph API), поэтому
 * логирование URL идёт через redact() — иначе токен попадёт в логи.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", params = {}, token, retries = 2, absoluteUrl } = options

  const url = new URL(absoluteUrl ?? `${config.graphHost}/${config.apiVersion}${path}`)
  const body = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (method === "GET" || method === "DELETE") url.searchParams.set(key, String(value))
    else body.set(key, String(value))
  }
  if (token) {
    if (method === "GET" || method === "DELETE") url.searchParams.set("access_token", token)
    else body.set("access_token", token)
  }

  let lastError: ApiError | undefined

  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle()
    log.debug(`${method} ${url.toString()}`)

    let res: Response
    try {
      res = await fetch(url, {
        method,
        ...(method === "GET" || method === "DELETE"
          ? {}
          : { body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }),
      })
    } catch (cause) {
      // Сетевая ошибка — повторяем, если попытки остались
      lastError = new ApiError(
        `Сеть недоступна: ${(cause as Error).message}`,
        0,
        undefined,
        undefined,
        "Проверь интернет-соединение",
      )
      if (attempt < retries) {
        await sleep(2 ** attempt * 1000)
        continue
      }
      throw lastError
    }

    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {}
    } catch {
      throw new ApiError(
        `Ответ не является JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
        res.status,
        undefined,
        undefined,
        "Похоже, обращение ушло не на Graph API — проверь THREADS_GRAPH_HOST",
      )
    }

    const errBody = parsed as MetaErrorBody
    if (!res.ok || errBody.error) {
      const e = errBody.error ?? {}
      const message = e.message ?? `HTTP ${res.status}`
      lastError = new ApiError(message, res.status, e.code, e.error_subcode, hintForCode(e.code, message))

      if (lastError.retryable && attempt < retries) {
        const backoff = 2 ** attempt * 1500
        log.warn(`${message} — повтор через ${Math.round(backoff / 1000)} с`)
        await sleep(backoff)
        continue
      }
      throw lastError
    }

    return parsed as T
  }

  throw lastError ?? new ApiError("Запрос не выполнен", 0)
}

/** GET-запрос с указанием полей (fields), которые нужно вернуть. */
export function get<T>(path: string, token: string, fields?: string[]): Promise<T> {
  return request<T>(path, {
    method: "GET",
    token,
    params: fields && fields.length > 0 ? { fields: fields.join(",") } : {},
  })
}
