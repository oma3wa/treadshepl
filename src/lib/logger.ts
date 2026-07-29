/**
 * Логгер с обязательным затиранием секретов.
 *
 * Токены Threads легко утекают в логи: они попадают в URL как query-параметр
 * access_token. Поэтому весь вывод проходит через redact() — иначе токен
 * окажется в CI-логах или в файле cron.
 */

const SECRET_PATTERNS: RegExp[] = [
  /access_token=([^&\s"']+)/gi,
  /client_secret=([^&\s"']+)/gi,
  /"access_token"\s*:\s*"([^"]+)"/gi,
]

/** Заменяет значения секретов на маску, оставляя последние 4 символа для отладки. */
export function redact(input: string): string {
  let out = input
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, secret: string) => {
      const tail = secret.length > 4 ? secret.slice(-4) : ""
      return match.replace(secret, `***${tail}`)
    })
  }
  return out
}

/** Короткая маска для токена: показываем только хвост. */
export function maskToken(token: string): string {
  return token.length > 8 ? `…${token.slice(-6)}` : "…"
}

const stringify = (parts: unknown[]): string =>
  parts
    .map((p) => (typeof p === "string" ? p : p instanceof Error ? (p.stack ?? p.message) : JSON.stringify(p)))
    .join(" ")

const quiet = () => process.env.THREADS_BOT_QUIET === "1"

export const log = {
  info(...parts: unknown[]): void {
    if (!quiet()) console.log(redact(stringify(parts)))
  },
  step(...parts: unknown[]): void {
    if (!quiet()) console.log("• " + redact(stringify(parts)))
  },
  ok(...parts: unknown[]): void {
    if (!quiet()) console.log("✓ " + redact(stringify(parts)))
  },
  warn(...parts: unknown[]): void {
    console.warn("⚠ " + redact(stringify(parts)))
  },
  error(...parts: unknown[]): void {
    console.error("✗ " + redact(stringify(parts)))
  },
  /** Подробный вывод только при THREADS_BOT_DEBUG=1 */
  debug(...parts: unknown[]): void {
    if (process.env.THREADS_BOT_DEBUG === "1") console.error("  [debug] " + redact(stringify(parts)))
  },
}
