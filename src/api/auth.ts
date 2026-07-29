/**
 * OAuth-поток Threads.
 *
 * Полная цепочка: ссылка авторизации → код → короткий токен (1 час)
 * → долгий токен (60 дней) → продление.
 *
 * Короткий токен для бота бесполезен, поэтому exchangeCode() сразу
 * меняет его на долгий: одна команда вместо двух шагов вручную.
 */

import { config, requireOAuthConfig } from "../config.js"
import { request } from "./client.js"
import { saveToken, loadTokenRaw, daysUntilExpiry } from "../store/tokens.js"
import { BotError } from "../lib/errors.js"
import { log, maskToken } from "../lib/logger.js"
import { SCOPES, type StoredToken } from "../types.js"

const DAY_SECONDS = 86_400

/** Ссылка, по которой пользователь разрешает приложению доступ к своему аккаунту. */
export function buildAuthUrl(): string {
  const { appId, redirectUri } = requireOAuthConfig()
  const url = new URL(`${config.authHost}/oauth/authorize`)
  url.searchParams.set("client_id", appId)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", SCOPES.join(","))
  url.searchParams.set("response_type", "code")
  return url.toString()
}

interface ShortTokenResponse {
  access_token: string
  user_id: string | number
}

interface LongTokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
}

/**
 * Обменивает код авторизации на долгоживущий токен и сохраняет его.
 *
 * Meta нередко добавляет к коду в адресной строке хвост `#_` — его нужно
 * отрезать, иначе обмен падает с невнятной ошибкой про неверный код.
 */
export async function exchangeCode(rawCode: string): Promise<StoredToken> {
  const { appId, appSecret, redirectUri } = requireOAuthConfig()
  const code = rawCode.trim().replace(/#_$/, "")

  if (code.length < 10) {
    throw new BotError("Код авторизации выглядит слишком коротким", "Скопируй значение параметра ?code= целиком")
  }

  const short = await request<ShortTokenResponse>("/oauth/access_token", {
    method: "POST",
    // Обмен кода идёт без версии в пути
    absoluteUrl: `${config.graphHost}/oauth/access_token`,
    params: {
      client_id: appId,
      client_secret: appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    },
    retries: 0, // код одноразовый: повтор всё равно не сработает
  })
  log.step(`Короткий токен получен (${maskToken(short.access_token)}), живёт 1 час`)

  const long = await request<LongTokenResponse>("/access_token", {
    method: "GET",
    absoluteUrl: `${config.graphHost}/access_token`,
    params: {
      grant_type: "th_exchange_token",
      client_secret: appSecret,
      access_token: short.access_token,
    },
  })

  const token: StoredToken = {
    accessToken: long.access_token,
    userId: String(short.user_id),
    expiresAt: Date.now() + (long.expires_in ?? 60 * DAY_SECONDS) * 1000,
    savedAt: new Date().toISOString(),
  }
  saveToken(token)
  return token
}

/**
 * Продлевает долгий токен ещё на 60 дней.
 *
 * Работает только если токену больше 24 часов и он ещё не истёк.
 * Пропустил окно — придётся проходить OAuth заново, поэтому команду
 * стоит поставить в cron.
 */
export async function refreshToken(): Promise<StoredToken> {
  const current = loadTokenRaw()
  const left = daysUntilExpiry(current)

  if (left < 0) {
    throw new BotError(
      "Токен уже истёк — продление невозможно",
      "Пройди авторизацию заново: npm run bot -- login",
    )
  }

  const ageHours = (Date.now() - new Date(current.savedAt).getTime()) / 3_600_000
  if (ageHours < 24) {
    throw new BotError(
      `Токен получен ${Math.round(ageHours)} ч назад`,
      "Meta разрешает продление только после 24 часов — повтори позже",
    )
  }

  const long = await request<LongTokenResponse>("/refresh_access_token", {
    method: "GET",
    absoluteUrl: `${config.graphHost}/refresh_access_token`,
    params: { grant_type: "th_refresh_token", access_token: current.accessToken },
  })

  const token: StoredToken = {
    accessToken: long.access_token,
    userId: current.userId,
    expiresAt: Date.now() + (long.expires_in ?? 60 * DAY_SECONDS) * 1000,
    savedAt: new Date().toISOString(),
  }
  saveToken(token)
  return token
}
