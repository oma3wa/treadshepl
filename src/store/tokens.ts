/**
 * Хранение долгоживущего токена.
 *
 * Файл создаётся с правами 0600: токен даёт полный доступ к публикации
 * от твоего имени, читать его должен только владелец.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DATA_DIR } from "../config.js"
import { BotError } from "../lib/errors.js"
import { maskToken, log } from "../lib/logger.js"
import type { StoredToken } from "../types.js"

const TOKEN_PATH = join(DATA_DIR, "tokens.json")

/** Порог, начиная с которого предупреждаем о скором истечении. */
export const WARN_DAYS_BEFORE_EXPIRY = 10

const DAY_MS = 86_400_000

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
}

export function saveToken(token: StoredToken): void {
  ensureDataDir()
  writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 })
  log.ok(`Токен сохранён (${maskToken(token.accessToken)}), действует до ${new Date(token.expiresAt).toLocaleDateString("ru-RU")}`)
}

export function tokenExists(): boolean {
  return existsSync(TOKEN_PATH)
}

/** Сколько полных суток осталось до истечения токена (может быть отрицательным). */
export function daysUntilExpiry(token: StoredToken): number {
  return Math.floor((token.expiresAt - Date.now()) / DAY_MS)
}

/**
 * Читает токен. Бросает понятную ошибку, если токена нет или он истёк —
 * иначе пользователь получил бы невнятный code 190 от Meta.
 */
export function loadToken(): StoredToken {
  if (!tokenExists()) {
    throw new BotError(
      "Токен не найден",
      "Выполни: npm run bot -- login   (получишь ссылку), затем: npm run bot -- exchange <code>",
    )
  }

  const token = JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as StoredToken
  const left = daysUntilExpiry(token)

  if (left < 0) {
    throw new BotError(
      `Токен истёк ${Math.abs(left)} дн. назад`,
      "Продлить уже нельзя — пройди авторизацию заново: npm run bot -- login",
    )
  }
  if (left <= WARN_DAYS_BEFORE_EXPIRY) {
    log.warn(`Токен истекает через ${left} дн. Продли: npm run bot -- refresh`)
  }
  return token
}

/** Токен без проверки срока — нужен команде refresh, чтобы починить почти истёкший. */
export function loadTokenRaw(): StoredToken {
  if (!tokenExists()) {
    throw new BotError("Токен не найден", "Сначала пройди авторизацию: npm run bot -- login")
  }
  return JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as StoredToken
}
