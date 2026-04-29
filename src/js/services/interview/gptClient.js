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
    maxTokens,
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
    if (typeof maxTokens === 'number' && maxTokens > 0) body.max_tokens = maxTokens;

    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/json',
                'Connection': 'keep-alive',
            },
            body: JSON.stringify(body),
            signal,
            keepalive: true,
        });
    } catch (e) {
        if (e?.name === 'AbortError' || signal?.aborted) throw e;
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
 * Stream a chat-completion via SSE. Calls `onDelta(text)` for each token
 * chunk and resolves with the full accumulated content.
 *
 * Falls back to non-streaming if the provider returns a non-SSE body.
 */
export async function chatCompletionStream({
    baseUrl,
    apiKey,
    model,
    messages,
    temperature = 0.4,
    maxTokens,
    signal,
    onDelta,
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
        stream: true,
    };
    if (typeof maxTokens === 'number' && maxTokens > 0) body.max_tokens = maxTokens;

    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'text/event-stream',
                'Connection': 'keep-alive',
            },
            body: JSON.stringify(body),
            signal,
            keepalive: true,
        });
    } catch (e) {
        if (e?.name === 'AbortError' || signal?.aborted) throw e;
        throw new GptClientError('network', 'GPT request failed: ' + e.message, e);
    }
    if (!res.ok) {
        let detail = '';
        try { detail = await res.text(); } catch { /* ignore */ }
        throw new GptClientError('http', `GPT API HTTP ${res.status}${detail ? ': ' + detail.slice(0, 400) : ''}`);
    }

    // If the provider didn't actually stream, fall through to text mode.
    if (!res.body || typeof res.body.getReader !== 'function') {
        const text = await res.text();
        return _extractContentFromMaybeSseOrJson(text, onDelta);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // SSE events are separated by blank lines (\n\n).
            let idx;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
                const event = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                const delta = _parseSseEvent(event);
                if (delta === '__DONE__') return full;
                if (delta) {
                    full += delta;
                    if (onDelta) try { onDelta(delta, full); } catch { /* ignore */ }
                }
            }
        }
        // Drain any trailing event.
        const tail = buffer.trim();
        if (tail) {
            const delta = _parseSseEvent(tail);
            if (delta && delta !== '__DONE__') {
                full += delta;
                if (onDelta) try { onDelta(delta, full); } catch { /* ignore */ }
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
    }
    return full;
}

function _parseSseEvent(event) {
    // event is one or more lines like "data: {...}" / "data: [DONE]".
    const lines = event.split('\n');
    let payload = '';
    for (const line of lines) {
        if (line.startsWith('data:')) payload += line.slice(5).trim();
    }
    if (!payload) return '';
    if (payload === '[DONE]') return '__DONE__';
    try {
        const j = JSON.parse(payload);
        return j?.choices?.[0]?.delta?.content || '';
    } catch {
        return '';
    }
}

function _extractContentFromMaybeSseOrJson(text, onDelta) {
    // Provider returned the whole body as one chunk; try SSE-style first,
    // then fall back to a plain chat-completion JSON object.
    const events = text.split('\n\n').filter(Boolean);
    let full = '';
    let sawSse = false;
    for (const ev of events) {
        if (ev.startsWith('data:')) {
            sawSse = true;
            const d = _parseSseEvent(ev);
            if (d === '__DONE__') break;
            if (d) {
                full += d;
                if (onDelta) try { onDelta(d, full); } catch { /* ignore */ }
            }
        }
    }
    if (sawSse) return full;
    try {
        const j = JSON.parse(text);
        const c = j?.choices?.[0]?.message?.content || '';
        if (c && onDelta) try { onDelta(c, c); } catch { /* ignore */ }
        return c;
    } catch (e) {
        throw new GptClientError(
            'parse',
            `GPT API returned non-JSON, non-SSE response. First 400 chars:\n${text.slice(0, 400)}`,
            e,
        );
    }
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
