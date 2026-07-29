/**
 * Тесты на чистых функциях — тех, что можно проверить без обращения к API.
 * Запуск: npm test (перед этим нужен npm run build).
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import { splitIntoParts, MAX_TEXT_LENGTH } from "../dist/api/publish.js"
import { parseWhen } from "../dist/store/queue.js"
import { matchRule } from "../dist/api/replies.js"
import { redact, maskToken } from "../dist/lib/logger.js"
import { hintForCode, ApiError } from "../dist/lib/errors.js"

describe("splitIntoParts — разбивка длинного текста", () => {
  test("короткий текст остаётся одной частью", () => {
    assert.deepEqual(splitIntoParts("Привет"), ["Привет"])
  })

  test("каждая часть не превышает лимит", () => {
    const long = "Слово ".repeat(400) // ~2400 символов
    for (const part of splitIntoParts(long)) {
      assert.ok(part.length <= MAX_TEXT_LENGTH, `часть длиной ${part.length} превысила лимит`)
    }
  })

  test("текст не теряется при разбивке", () => {
    const long = "Предложение номер один. Предложение номер два. ".repeat(30)
    const joined = splitIntoParts(long).join(" ").replace(/\s+/g, " ").trim()
    assert.equal(joined, long.replace(/\s+/g, " ").trim())
  })

  test("предпочитает резать по границе предложения", () => {
    const text = "А".repeat(400) + ". " + "Б".repeat(300)
    const parts = splitIntoParts(text)
    assert.ok(parts[0].endsWith("."), "первая часть должна заканчиваться точкой")
  })

  test("не создаёт пустых частей", () => {
    for (const part of splitIntoParts("Тест. ".repeat(200))) {
      assert.ok(part.trim().length > 0)
    }
  })
})

describe("parseWhen — разбор времени публикации", () => {
  test("относительное время в минутах", () => {
    const diff = parseWhen("+30m").getTime() - Date.now()
    assert.ok(Math.abs(diff - 30 * 60_000) < 2000)
  })

  test("относительное время в часах", () => {
    const diff = parseWhen("+2h").getTime() - Date.now()
    assert.ok(Math.abs(diff - 2 * 3_600_000) < 2000)
  })

  test("относительное время в днях", () => {
    const diff = parseWhen("+1d").getTime() - Date.now()
    assert.ok(Math.abs(diff - 86_400_000) < 2000)
  })

  test("формат с пробелом вместо T", () => {
    const d = parseWhen("2026-08-01 09:30")
    assert.equal(d.getFullYear(), 2026)
    assert.equal(d.getMonth(), 7) // август
    assert.equal(d.getDate(), 1)
  })

  test("ISO-формат", () => {
    assert.equal(parseWhen("2026-08-01T09:30:00Z").toISOString(), "2026-08-01T09:30:00.000Z")
  })

  test("мусор превращается в невалидную дату, а не в исключение", () => {
    assert.ok(Number.isNaN(parseWhen("не дата").getTime()))
  })
})

describe("matchRule — правила автоответа", () => {
  const cfg = {
    rules: [
      { pattern: "привет|здравствуй", responses: ["Привет!"] },
      { pattern: "цена|стоимость", responses: ["Написал в личку"] },
    ],
    maxPerRun: 5,
  }

  test("находит правило без учёта регистра", () => {
    assert.equal(matchRule("ПРИВЕТ всем", cfg), "Привет!")
  })

  test("срабатывает на второй вариант в шаблоне", () => {
    assert.equal(matchRule("а какая стоимость?", cfg), "Написал в личку")
  })

  test("возвращает undefined, если ничего не подошло", () => {
    assert.equal(matchRule("случайный текст", cfg), undefined)
  })

  test("не падает на некорректном регулярном выражении", () => {
    const broken = { rules: [{ pattern: "[невалидный", responses: ["x"] }], maxPerRun: 1 }
    assert.equal(matchRule("что угодно", broken), undefined)
  })

  test("выбирает один из нескольких вариантов ответа", () => {
    const multi = { rules: [{ pattern: "тест", responses: ["A", "B", "C"] }], maxPerRun: 1 }
    assert.ok(["A", "B", "C"].includes(matchRule("тест", multi)))
  })

  test("пустой список ответов не приводит к выбору правила", () => {
    const empty = { rules: [{ pattern: "тест", responses: [] }], maxPerRun: 1 }
    assert.equal(matchRule("тест", empty), undefined)
  })
})

describe("redact — затирание секретов в логах", () => {
  test("затирает access_token в URL", () => {
    const out = redact("GET https://graph.threads.net/v1.0/me?access_token=THIS_IS_SECRET_VALUE")
    assert.ok(!out.includes("THIS_IS_SECRET_VALUE"), "токен не должен попадать в лог")
    assert.ok(out.includes("***"), "должна остаться маска")
  })

  test("затирает client_secret", () => {
    const out = redact("client_secret=abcdef123456&grant_type=x")
    assert.ok(!out.includes("abcdef123456"))
  })

  test("затирает access_token в JSON", () => {
    const out = redact('{"access_token":"SUPER_SECRET_TOKEN"}')
    assert.ok(!out.includes("SUPER_SECRET_TOKEN"))
  })

  test("обычный текст не меняется", () => {
    assert.equal(redact("Опубликовано успешно"), "Опубликовано успешно")
  })

  test("maskToken показывает только хвост", () => {
    const masked = maskToken("ABCDEFGHIJKLMNOP")
    assert.ok(!masked.includes("ABCDEFGH"))
    assert.ok(masked.includes("KLMNOP"))
  })
})

describe("Расшифровка ошибок Meta", () => {
  test("код 190 объясняет проблему с токеном", () => {
    assert.match(hintForCode(190, "Invalid OAuth access token"), /токен/i)
  })

  test("код 4 объясняет лимит запросов", () => {
    assert.match(hintForCode(4, "Application request limit reached"), /лимит/i)
  })

  test("подсказка по тексту ошибки, если код неизвестен", () => {
    assert.match(hintForCode(9999, "The permission is missing"), /разрешени/i)
  })

  test("для незнакомой ошибки подсказки нет", () => {
    assert.equal(hintForCode(undefined, "нечто совершенно новое"), undefined)
  })

  test("ошибки 5xx помечаются как повторяемые", () => {
    assert.equal(new ApiError("Server error", 503).retryable, true)
  })

  test("ошибки троттлинга помечаются как повторяемые", () => {
    assert.equal(new ApiError("Rate limited", 400, 4).retryable, true)
  })

  test("ошибка неверного токена НЕ повторяется", () => {
    assert.equal(new ApiError("Bad token", 400, 190).retryable, false)
  })
})
