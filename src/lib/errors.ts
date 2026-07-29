/**
 * Ошибки бота и расшифровка кодов Meta.
 *
 * Сырые ошибки Graph API малоинформативны: часто это «Invalid parameter»
 * без указания, какой параметр. Здесь они превращаются в понятные сообщения
 * с подсказкой, что делать дальше.
 */

/** Ошибка, которую можно показать пользователю как есть. */
export class BotError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = "BotError"
  }
}

/** Ошибка, пришедшая от Graph API. */
export class ApiError extends BotError {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: number,
    readonly subcode?: number,
    hint?: string,
  ) {
    super(message, hint)
    this.name = "ApiError"
  }

  /** Стоит ли повторить запрос: сеть, троттлинг и 5xx — да; 4xx по смыслу — нет. */
  get retryable(): boolean {
    if (this.httpStatus >= 500) return true
    // 4, 17, 32, 613 — семейство ошибок «слишком много запросов»
    return [4, 17, 32, 613].includes(this.code ?? -1)
  }
}

/** Коды Graph API, которые встречаются чаще всего, и что с ними делать. */
const CODE_HINTS: Record<number, string> = {
  1: "Неизвестная ошибка на стороне Meta — обычно помогает повтор через минуту",
  2: "Сервис Meta временно недоступен — повтори позже",
  4: "Достигнут лимит запросов приложения — подожди и снизь частоту",
  10: "Разрешение не выдано приложению: проверь scopes и переавторизуйся",
  17: "Достигнут лимит запросов пользователя — подожди",
  32: "Достигнут лимит обращений к странице — подожди",
  100: "Неверный параметр запроса: проверь id, поля и тип медиа",
  190: "Токен недействителен или истёк — выполни refresh, иначе переавторизацию",
  200: "Недостаточно прав: нужный scope не одобрен или не выдан при авторизации",
  613: "Превышена частота вызовов — включи паузы между запросами",
}

/** Достаём человекочитаемую подсказку по коду ошибки Meta. */
export function hintForCode(code: number | undefined, message: string): string | undefined {
  if (code !== undefined && CODE_HINTS[code]) return CODE_HINTS[code]

  const lower = message.toLowerCase()
  if (lower.includes("permission")) return "Не хватает разрешения — проверь scopes приложения"
  if (lower.includes("expired")) return "Срок действия истёк — обнови токен"
  if (lower.includes("media_type")) return "Проверь media_type: TEXT, IMAGE, VIDEO или CAROUSEL"
  if (lower.includes("image_url") || lower.includes("video_url")) {
    return "URL медиа должен быть публично доступен по HTTPS без авторизации"
  }
  return undefined
}
