/**
 * POST /api/summarize  { url }  ->  { summary }
 *
 * Дві сторонні залежності, обидві безкоштовні:
 *   r.jina.ai  — витягує читабельний текст статті, ключа не потребує;
 *   Groq       — сумаризує, llama-3.3-70b-versatile, ~14 400 запитів на добу.
 *
 * Ключ читається з оточення і живе тільки тут. У попередній версії він був
 * VITE_-змінною, тобто вкомпільовувався у клієнтський бандл і був видимий
 * кожному, хто відкриє вихідний код сторінки.
 */

// Провайдери ланцюжка фолбеку. Groq/OpenAI/xAI нативно OpenAI-сумісні, Gemini має
// OpenAI-сумісний ендпоінт. Порядок: поточний (Groq) -> чотири спільні ключі ->
// ключі2.txt в останню чергу; відсутні пропускаються, дублі (провайдер, ключ)
// згортаються. Мертвий ключ або вичерпана квота на одному -> беремо наступний.
const PROVIDERS = {
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-2.5-flash" },
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
  xai: { url: "https://api.x.ai/v1/chat/completions", model: "grok-2-latest" },
};

// (провайдер, env-змінна) у порядку ланцюжка; `primaryGroqKey` стає першим.
const CHAIN_VARS = [
  ["gemini", "GEMINI_API_KEY"],
  ["groq", "GROQ_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["xai", "XAI_API_KEY"],
  ["gemini", "GEMINI_API_KEY_2"],
  ["gemini", "GEMINI_API_KEY_3"],
  ["groq", "GROQ_API_KEY_2"],
];

function providerChain(primaryGroqKey, env = process.env) {
  const out = [];
  const seen = new Set();
  const add = (provider, label, key) => {
    const k = (key ?? "").trim();
    if (k === "" || seen.has(`${provider}:${k}`)) return;
    seen.add(`${provider}:${k}`);
    out.push({ label, url: PROVIDERS[provider].url, model: PROVIDERS[provider].model, apiKey: k });
  };
  add("groq", "groq:primary", primaryGroqKey);
  for (const [provider, v] of CHAIN_VARS) add(provider, `${provider}:${v}`, env[v]);
  return out;
}

// Стільки символів статті віддаємо моделі. Ліміт не заради вартості, а щоб
// довга сторінка не впиралась у контекст і не робила запит повільним.
const MAX_ARTICLE_CHARS = 24000;

const SYSTEM_PROMPT =
  "You summarize articles. Return three to four sentences of plain prose " +
  "covering what the article is about and its main points. Write in the " +
  "language the article is written in. No preamble, no bullet points, no " +
  "markdown — just the summary text.";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function assertPublicHttpUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(400, "That does not look like a valid URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, "Only http and https links are supported.");
  }

  // Функція ходить у мережу за адресою, яку дав користувач, тож без цієї
  // перевірки її можна попросити постукати у внутрішню мережу (SSRF).
  const host = parsed.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith("[");

  if (blocked) {
    throw new HttpError(400, "That address is not publicly reachable.");
  }

  return parsed.toString();
}

async function fetchArticleText(url) {
  const response = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: "text/plain" },
    signal: AbortSignal.timeout(25000),
  });

  if (!response.ok) {
    throw new HttpError(
      502,
      `Could not read that page (reader returned ${response.status}).`
    );
  }

  const text = (await response.text()).trim();

  if (text.length < 200) {
    throw new HttpError(
      422,
      "There was not enough readable text on that page to summarize."
    );
  }

  return text.slice(0, MAX_ARTICLE_CHARS);
}

async function summarize(articleText, chain) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: articleText },
  ];

  let rateLimited = false;
  const errors = [];

  for (const p of chain) {
    let response;
    try {
      response = await fetch(p.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: p.model, temperature: 0.2, max_tokens: 400, messages }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      // Таймаут не ганяємо по всьому ланцюжку — інакше N провайдерів x 30с.
      if (err?.name === "TimeoutError" || err?.name === "AbortError") throw err;
      errors.push(`${p.label}: ${String(err?.message || err).slice(0, 120)}`);
      continue;
    }

    if (response.status === 429) {
      rateLimited = true;
      errors.push(`${p.label}: 429`);
      continue;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("%s error %s: %s", p.label, response.status, detail.slice(0, 300));
      errors.push(`${p.label}: ${response.status}`);
      continue;
    }

    const data = await response.json();
    const summary = data?.choices?.[0]?.message?.content?.trim();
    if (summary) return summary;
    errors.push(`${p.label}: empty`);
  }

  console.error("all providers failed: %s", errors.join(" | "));
  // Якщо хоч один впав через ліміт — чесніше сказати про ліміт, інакше 502.
  if (rateLimited) throw new HttpError(429, "Rate limit reached. Try again in a minute.");
  throw new HttpError(502, "The summarizer is unavailable right now.");
}

/** Ядро без HTTP-обгортки — щоб його можна було викликати з тесту напряму. */
export async function summarizeUrl(rawUrl, apiKey) {
  const url = assertPublicHttpUrl(rawUrl);
  // `apiKey` (основний Groq-ключ) стає першим у ланцюжку; решта — з оточення.
  const chain = providerChain(apiKey);
  if (chain.length === 0) {
    throw new HttpError(500, "The server is missing its API key.");
  }
  const articleText = await fetchArticleText(url);
  return summarize(articleText, chain);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  if (providerChain(process.env.GROQ_API_KEY).length === 0) {
    console.error("no provider key is set");
    return res.status(500).json({ error: "The server is missing its API key." });
  }

  const url = req.body?.url;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Send a JSON body with a url field." });
  }

  try {
    const summary = await summarizeUrl(url, process.env.GROQ_API_KEY);
    return res.status(200).json({ summary });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return res.status(504).json({ error: "That page took too long to read." });
    }
    console.error("Unhandled error in /api/summarize:", err);
    return res.status(500).json({ error: "Something went wrong." });
  }
}
