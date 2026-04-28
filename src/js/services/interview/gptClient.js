/**
 * gptClient — minimal OpenAI-compatible chat-completions client.
 *
 * IMPORTANT — what this module is NOT:
 *   - it does NOT use a ChatGPT account
 *   - it does NOT scrape, automate, or render chatgpt.com
 *   - it does NOT read or store browser cookies / sessions / passwords
 *
 * It only POSTs to `${baseUrl}/chat/completions` with `Authorization: Bearer ${apiKey}`,
 * which is the standard OpenAI REST API supported by OpenAI itself, Azure
 * OpenAI (compatible mode), Groq, Together, OpenRouter, llama.cpp server, etc.
 */

export class GptClientError extends Error {
    constructor(code, message, cause) {
        super(message);
        this.code = code; // 'missing-key' | 'network' | 'http' | 'parse' | 'invalid'
        this.cause = cause;
        this.name = 'GptClientError';
    }
}

/**
 * Try to parse the model's reply as JSON. The Combined-Mode prompt asks the
 * model to "Return only valid JSON. Do not include markdown." but real-world
 * models still occasionally wrap output in code fences or trailing prose, so
 * we normalize before `JSON.parse`.
 */
export function parseJsonFromCompletion(raw) {
    if (raw == null) throw new GptClientError('parse', 'Empty completion');
    let text = String(raw).trim();
    // Strip Markdown code fences (``` or ```json … ```).
    if (text.startsWith('```')) {
        text = text.replace(/^```(?:json|JSON)?\s*/, '').replace(/\s*```\s*$/, '');
    }
    // If there's leading or trailing prose, snip the first JSON object.
    if (!text.startsWith('{') || !text.endsWith('}')) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end > start) {
            text = text.slice(start, end + 1);
        }
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new GptClientError('parse', 'Failed to parse model JSON: ' + e.message, e);
    }
}

/**
 * Call an OpenAI-compatible chat-completions endpoint.
 * @param {object} opts
 * @param {string} opts.baseUrl       - e.g. https://api.openai.com/v1
 * @param {string} opts.apiKey        - Bearer token
 * @param {string} opts.model         - e.g. gpt-4o-mini
 * @param {Array}  opts.messages      - chat-completions messages array
 * @param {number} [opts.temperature] - default 0.4
 * @param {boolean}[opts.jsonResponse]- request response_format=json_object
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{content: string, raw: any}>}
 */
export async function chatCompletion({
    baseUrl,
    apiKey,
    model,
    messages,
    temperature = 0.4,
    jsonResponse = false,
    signal,
}) {
    if (!apiKey || !apiKey.trim()) {
        throw new GptClientError('missing-key', 'GPT_API_KEY is missing');
    }
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new GptClientError('invalid', 'messages must be a non-empty array');
    }
    const url = String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
    const body = {
        model: model || 'gpt-4o-mini',
        messages,
        temperature,
    };
    if (jsonResponse) body.response_format = { type: 'json_object' };

    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/json',
            },
            body: JSON.stringify(body),
            signal,
        });
    } catch (e) {
        throw new GptClientError('network', 'GPT request failed: ' + e.message, e);
    }

    // Read body as text first so we can report what actually came back even
    // if it isn't JSON. Some OpenAI-compatible providers return SSE / plain
    // text / HTML error pages with a 2xx status, which a naive res.json()
    // hides behind an opaque parse error.
    let bodyText = '';
    try {
        bodyText = await res.text();
    } catch (e) {
        throw new GptClientError('network', 'Could not read GPT response body: ' + e.message, e);
    }

    if (!res.ok) {
        const snippet = bodyText ? ': ' + bodyText.slice(0, 400) : '';
        throw new GptClientError('http', `GPT API HTTP ${res.status}${snippet}`);
    }

    let json;
    try {
        json = JSON.parse(bodyText);
    } catch (e) {
        const snippet = bodyText ? bodyText.slice(0, 400) : '(empty body)';
        throw new GptClientError(
            'parse',
            `GPT API returned non-JSON response. First 400 chars:\n${snippet}`,
            e,
        );
    }

    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
        const apiErr = json?.error?.message || JSON.stringify(json).slice(0, 400);
        throw new GptClientError('invalid', `No completion content in GPT response. ${apiErr}`);
    }
    return { content, raw: json };
}

/**
 * Convenience wrapper — calls `chatCompletion`, parses the answer as JSON,
 * and retries once if parsing fails. Handles two failure modes:
 *  1. HTTP body was not JSON (transport-level parse error) — retry once
 *     with `response_format` removed in case the provider doesn't support it.
 *  2. HTTP body was JSON but the model's `content` wasn't — retry once,
 *     re-asking the model to reply with valid JSON only.
 */
export async function chatCompletionJson(opts) {
    let first;
    try {
        first = await chatCompletion({ ...opts, jsonResponse: true });
    } catch (e0) {
        // Some OpenAI-compatible providers don't honor response_format and
        // return a non-JSON body. Retry once without the json_object hint.
        if (e0?.code === 'parse') {
            first = await chatCompletion({ ...opts, jsonResponse: false });
        } else {
            throw e0;
        }
    }

    try {
        return { json: parseJsonFromCompletion(first.content), content: first.content };
    } catch (e1) {
        // Model's content wasn't valid JSON — re-ask once with explicit reminder.
        const retryMessages = [
            ...opts.messages,
            { role: 'assistant', content: first.content },
            {
                role: 'user',
                content: 'Your previous response was not valid JSON. Reply again with ONLY a single JSON object, no markdown, no extra text.',
            },
        ];
        const second = await chatCompletion({ ...opts, messages: retryMessages, jsonResponse: true });
        return { json: parseJsonFromCompletion(second.content), content: second.content };
    }
}
