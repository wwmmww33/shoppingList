// One entry point for the app's AI features (item category, category
// suggestions, brand-photo reading), so the provider is a setting in .env
// rather than code:
//
//   AI_PROVIDER=gemini        (or deepseek; optional, see below)
//   GEMINI_API_KEY=...        free key from https://aistudio.google.com
//   GEMINI_MODEL=gemini-2.5-flash
//   DEEPSEEK_API_KEY=...
//   DEEPSEEK_VISION_MODEL=...  (DeepSeek only; image reading)
//
// Without AI_PROVIDER, whichever key is set is used (Gemini first). With no
// key at all every feature just returns "no suggestion", as before.

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

const getAIProvider = () => {
  const wanted = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (wanted === 'gemini') return process.env.GEMINI_API_KEY ? 'gemini' : null;
  if (wanted === 'deepseek') return process.env.DEEPSEEK_API_KEY ? 'deepseek' : null;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  return null;
};

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const askGemini = async ({ prompt, imageBase64, maxTokens, timeoutMs }) => {
  const model = (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
  const parts = [{ text: prompt }];
  if (imageBase64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } });
  const generationConfig = { temperature: 0.2 };
  // 2.5 Flash "thinks" by default, and thinking tokens count against
  // maxOutputTokens — with the small budgets used here (20 for a category
  // key) the visible answer could come back empty. Turn thinking off for it;
  // for other models (which may not accept a 0 budget), leave thinking alone
  // but give the answer enough room.
  if (/2\.5-flash/.test(model)) {
    generationConfig.maxOutputTokens = maxTokens;
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  } else {
    generationConfig.maxOutputTokens = Math.max(maxTokens, 2048);
  }
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
    },
    timeoutMs
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { ok: false, status: response.status, error: body.slice(0, 300) };
  }
  const data = await response.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  return { ok: true, text };
};

const askDeepSeek = async ({ prompt, imageBase64, maxTokens, timeoutMs }) => {
  const content = imageBase64
    ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }]
    : prompt;
  const response = await fetchWithTimeout(
    'https://api.deepseek.com/chat/completions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: imageBase64 ? process.env.DEEPSEEK_VISION_MODEL || 'deepseek-v4-flash-vision-exp' : 'deepseek-chat',
        messages: [{ role: 'user', content }],
        max_tokens: maxTokens,
      }),
    },
    timeoutMs
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { ok: false, status: response.status, error: body.slice(0, 300) };
  }
  const data = await response.json();
  return { ok: true, text: data?.choices?.[0]?.message?.content || '' };
};

// Returns { ok: true, text } or { ok: false, reason, status?, error? }.
// Never throws: AI is always a best-effort suggestion in this app.
const askAI = async ({ prompt, imageBase64 = null, maxTokens = 300, timeoutMs = 15000 }) => {
  const provider = getAIProvider();
  if (!provider) return { ok: false, reason: 'no_api_key' };
  try {
    const result = await (provider === 'gemini' ? askGemini : askDeepSeek)({ prompt, imageBase64, maxTokens, timeoutMs });
    if (!result.ok) {
      console.error(`AI request (${provider}) failed: HTTP`, result.status, result.error);
      return { ok: false, reason: 'http_' + result.status };
    }
    return { ok: true, text: result.text };
  } catch (err) {
    console.error(`AI request (${provider}) failed:`, err.message);
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : 'network_error' };
  }
};

module.exports = { askAI, getAIProvider };
