/**
 * combinedAnswerService — drives Combined Mode.
 *
 * When BOTH the Translator and the Interview Assistant are active, each
 * detected question is fed to GPT (via the OpenAI-compatible REST API) and
 * a single concise answer (3-6 sentences) is streamed back into the
 * Interview Assistant view.
 *
 * Anti-spam guarantees:
 *   - Caches the last N (~10) question fingerprints + their answers
 *   - Skips the call if a near-duplicate question (Dice ≥ 0.85) is already cached
 *   - Skips the call if the question has fewer than `minWords` tokens
 *   - Aborts in-flight requests when a fresher question arrives
 */

import { chatCompletionStream, chatCompletion, GptClientError } from './gptClient.js';
import { fingerprint } from '../../utils/hashUtils.js';
import { isSimilar, normalizeText } from '../../utils/textSimilarity.js';

function buildSystemPrompt({ targetLanguage = 'Deutsch', languageLevel = 'A2-B1' } = {}) {
    const lang = String(targetLanguage || 'Deutsch');
    const level = String(languageLevel || 'A2-B1');
    return [
        'You are an interview assistant. Answer the interviewer\'s question with one natural answer only.',
        'Do not include short answers. Do not give multiple options.',
        'Keep the answer concise and sufficient, around 3-6 sentences depending on question complexity.',
        `Always reply in ${lang} at language level ${level}, regardless of the question language.`,
        'Use simple, natural sentences and clear grammar. Do not invent fake experience.',
    ].join(' ');
}

const ALLOWED_STYLES = new Set(['natural', 'simpler']);

export class CombinedAnswerService {
    constructor({
        getSettings,
        cacheSize = 10,
        onStatus,
        onAnswer,
        onPartial,
        onError,
    } = {}) {
        if (typeof getSettings !== 'function') {
            throw new Error('CombinedAnswerService requires getSettings()');
        }
        this.getSettings = getSettings;
        this.cacheSize = cacheSize;
        this.onStatus = onStatus || (() => {});
        this.onAnswer = onAnswer || (() => {});
        this.onPartial = onPartial || (() => {});
        this.onError = onError || (() => {});
        this._cache = []; // [{ fp, normalized, answer }]
        this._inflight = null; // { controller, key }
        this.lastQuestion = null;
        this.lastResult = null;
    }

    /**
     * Manually request an answer for the given question. Bypasses the
     * "is this a question?" heuristic — used when the user hits the
     * "Generate Answer" button.
     */
    async generate({ originalTranscript, vietnameseTranslation, detectedLanguage, style = 'natural', force = false } = {}) {
        const settings = this.getSettings();
        const apiKey = (settings.gptApiKey || '').trim();
        if (!apiKey) {
            const err = new GptClientError(
                'missing-key',
                'Vui lòng nhập GPT_API_KEY trong Settings để tạo câu trả lời gợi ý.',
            );
            this.onError(err);
            throw err;
        }
        const question = (originalTranscript || '').trim();
        if (!question) {
            this.onStatus('idle');
            return null;
        }
        const wordCount = question.split(/\s+/).filter(Boolean).length;
        if (!force && wordCount < (settings.gptMinWords || 5)) {
            this.onStatus('skipped-short');
            return null;
        }

        const styleHint = ALLOWED_STYLES.has(style) ? style : 'natural';
        const fp = fingerprint(question);
        const norm = normalizeText(question);
        if (!force) {
            const cached = this._cacheLookup(fp, norm, settings.duplicateThreshold || 0.85, styleHint);
            if (cached) {
                this.lastQuestion = question;
                this.lastResult = cached.answer;
                this.onAnswer({ ...cached.answer, fromCache: true });
                this.onStatus('cached');
                return cached.answer;
            }
        }

        // Cancel any prior in-flight request.
        if (this._inflight) {
            try { this._inflight.controller.abort(); } catch { /* ignore */ }
            this._inflight = null;
        }

        const ctx = settings.ivContext || {};
        const systemPrompt = buildSystemPrompt({
            targetLanguage: ctx.targetLanguage,
            languageLevel: ctx.languageLevel,
        });
        const userPrompt = buildUserPrompt({
            question,
            detectedLanguage,
            vietnameseTranslation,
            style: styleHint,
            targetLanguage: ctx.targetLanguage,
        });
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        const controller = new AbortController();
        this._inflight = { controller, key: fp };
        this.onStatus('loading');

        const maxTokens = Math.max(120, Number(settings.gptMaxTokens) || 600);
        const useStreaming = settings.combinedStreaming !== false; // default ON
        let answerText = '';
        try {
            if (useStreaming) {
                answerText = await chatCompletionStream({
                    baseUrl: settings.gptBaseUrl,
                    apiKey,
                    model: settings.gptModel,
                    messages,
                    temperature: styleHint === 'simpler' ? 0.55 : 0.35,
                    maxTokens,
                    signal: controller.signal,
                    onDelta: (_delta, full) => {
                        try { this.onPartial({ answer: full, question, fromCache: false }); } catch { /* ignore */ }
                    },
                });
            } else {
                const r = await chatCompletion({
                    baseUrl: settings.gptBaseUrl,
                    apiKey,
                    model: settings.gptModel,
                    messages,
                    temperature: styleHint === 'simpler' ? 0.55 : 0.35,
                    maxTokens,
                    signal: controller.signal,
                });
                answerText = r.content;
            }
        } catch (e) {
            if (e?.name === 'AbortError') {
                this.onStatus('aborted');
                return null;
            }
            this.onStatus('error');
            this.onError(e);
            throw e;
        } finally {
            if (this._inflight && this._inflight.controller === controller) {
                this._inflight = null;
            }
        }

        const cleaned = cleanAnswer(answerText);
        const answer = {
            question,
            answer: cleaned,
            language: detectedLanguage || '',
            style: styleHint,
            createdAt: Date.now(),
            fromCache: false,
        };
        this._cachePut(fp, norm, answer, styleHint);
        this.lastQuestion = question;
        this.lastResult = answer;
        this.onAnswer(answer);
        this.onStatus('answer');
        return answer;
    }

    /**
     * Hook into the QuestionDetectionPipeline. Called once per debounced,
     * deduped question detection. Auto-cancels any in-flight request and
     * starts a new one for the freshest question.
     */
    async onDetectedQuestion({ text, language, vietnameseTranslation }) {
        const settings = this.getSettings();
        if (!settings.combinedMode || !settings.combinedAutoCall) return null;
        if (!settings.gptApiKey) {
            this.onStatus('missing-key');
            return null;
        }
        try {
            return await this.generate({
                originalTranscript: text,
                vietnameseTranslation,
                detectedLanguage: language,
                style: 'natural',
            });
        } catch {
            // generate() already invoked onError + onStatus.
            return null;
        }
    }

    /** Force a fresh call regardless of cache (used by the Regenerate button). */
    regenerate(opts) {
        return this.generate({ ...opts, force: true });
    }

    clearCache() {
        this._cache.length = 0;
        this.lastQuestion = null;
        this.lastResult = null;
    }

    _cacheLookup(fp, norm, threshold, style = 'natural') {
        for (const entry of this._cache) {
            if (entry.style !== style) continue;
            if (entry.fp === fp) return entry;
            if (isSimilar(entry.normalized, norm, threshold)) return entry;
        }
        return null;
    }

    _cachePut(fp, norm, answer, style = 'natural') {
        this._cache.unshift({ fp, normalized: norm, style, answer });
        while (this._cache.length > this.cacheSize) this._cache.pop();
    }
}

function buildUserPrompt({ question, detectedLanguage, vietnameseTranslation, style, targetLanguage }) {
    const lines = [];
    lines.push(`Question: ${question}`);
    if (detectedLanguage) lines.push(`Detected language: ${detectedLanguage}`);
    if (vietnameseTranslation) lines.push(`Vietnamese translation of question: ${vietnameseTranslation}`);
    if (targetLanguage) lines.push(`Answer language: ${targetLanguage}`);
    if (style === 'simpler') lines.push('Style hint: use the simplest possible language.');
    lines.push(
        'Reply with ONLY the answer text — no preamble, no labels, no markdown, no JSON. ' +
        '3-6 sentences total.',
    );
    return lines.join('\n');
}

function cleanAnswer(raw) {
    if (!raw) return '';
    let text = String(raw).trim();
    // Strip stray markdown code fences.
    if (text.startsWith('```')) {
        text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '');
    }
    // Strip a leading "Answer:" / "Antwort:" / "Trả lời:" label if the model added one.
    text = text.replace(/^(Answer|Antwort|Trả lời|Suggested answer)\s*:\s*/i, '');
    return text.trim();
}
