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

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

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

async function summarize(articleText, apiKey) {
  const response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: articleText },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (response.status === 429) {
    throw new HttpError(429, "Rate limit reached. Try again in a minute.");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("Groq error %s: %s", response.status, detail.slice(0, 500));
    throw new HttpError(502, "The summarizer is unavailable right now.");
  }

  const data = await response.json();
  const summary = data?.choices?.[0]?.message?.content?.trim();

  if (!summary) {
    throw new HttpError(502, "The summarizer returned an empty response.");
  }

  return summary;
}

/** Ядро без HTTP-обгортки — щоб його можна було викликати з тесту напряму. */
export async function summarizeUrl(rawUrl, apiKey) {
  const url = assertPublicHttpUrl(rawUrl);
  const articleText = await fetchArticleText(url);
  return summarize(articleText, apiKey);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("GROQ_API_KEY is not set");
    return res.status(500).json({ error: "The server is missing its API key." });
  }

  const url = req.body?.url;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Send a JSON body with a url field." });
  }

  try {
    const summary = await summarizeUrl(url, apiKey);
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
