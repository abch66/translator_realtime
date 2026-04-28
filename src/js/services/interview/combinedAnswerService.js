/**
 * combinedAnswerService — drives Combined Mode.
 *
 * When BOTH the Translator and the Interview Assistant are active, each
 * detected question is fed to GPT (via the OpenAI-compatible REST API) and
 * the resulting JSON answer (short / full / VI translation / vocabulary /
 * confidence) is rendered in the Interview Assistant view.
 *
 * Anti-spam guarantees:
 *   - Caches the last N (~10) question fingerprints + their answers
 *   - Skips the call if a near-duplicate question (Dice ≥ 0.85) is already cached
 *   - Skips the call if the question has fewer than `minWords` tokens
 *   - Aborts in-flight requests when a fresher question arrives
 */

import { chatCompletionJson, GptClientError } from './gptClient.js';
import { fingerprint } from '../../utils/hashUtils.js';
import { isSimilar, normalizeText } from '../../utils/textSimilarity.js';

const SYSTEM_PROMPT = `You are an interview assistant for Ausbildung interviews in Germany.
The user is a Vietnamese learner of German.
Your task is to analyze real-time transcription and create a helpful interview answer suggestion.

Rules:
- Use simple and natural language.
- Default language level is A2-B1.
- Use short sentences and clear grammar.
- Do not invent fake experience.
- If information is missing, give a general but realistic answer.
- Always include a Vietnamese translation.
- Return only valid JSON.
- Do not include markdown.`;

function buildUserPrompt({
    originalTranscript,
    vietnameseTranslation,
    detectedLanguage,
    targetLanguage,
    languageLevel,
    beruf,
    companyName,
    userBackground,
    strengths,
    workExperience,
    style = 'natural',
}) {
    return [
        'Original transcript:',
        originalTranscript || '(empty)',
        '',
        'Vietnamese translation:',
        vietnameseTranslation || '(none — translate yourself if needed)',
        '',
        'Detected language:',
        detectedLanguage || 'unknown',
        '',
        'Interview context:',
        `- Target language: ${targetLanguage || 'Deutsch'}`,
        `- Language level: ${languageLevel || 'A2-B1'}`,
        `- Ausbildung/Beruf: ${beruf || ''}`,
        `- Company: ${companyName || ''}`,
        `- User background: ${userBackground || ''}`,
        `- Strengths: ${strengths || ''}`,
        `- Work experience: ${workExperience || ''}`,
        `- Style hint: ${style}`,
        '',
        'Task:',
        '1. Decide if this is an interview question.',
        '2. If yes, create a short suggested answer (1-2 sentences).',
        '3. Create a fuller suggested answer (3-5 sentences).',
        '4. Translate the answer into Vietnamese.',
        '5. Extract important vocabulary (max 8 items, each with Vietnamese meaning).',
        '6. Return JSON only with this exact shape:',
        '{',
        '  "is_interview_question": boolean,',
        '  "detected_question": string,',
        '  "question_vi": string,',
        '  "short_answer": string,',
        '  "full_answer": string,',
        '  "answer_vi": string,',
        '  "important_vocabulary": [{ "word": string, "meaning_vi": string }],',
        '  "confidence": number',
        '}',
        'If it is NOT an interview question, return:',
        '{ "is_interview_question": false, "reason": string, "confidence": number }',
    ].join('\n');
}

const ALLOWED_STYLES = new Set(['natural', 'shorter', 'simpler']);

export class CombinedAnswerService {
    constructor({
        getSettings,
        cacheSize = 10,
        onStatus,
        onAnswer,
        onError,
    } = {}) {
        if (typeof getSettings !== 'function') {
            throw new Error('CombinedAnswerService requires getSettings()');
        }
        this.getSettings = getSettings;
        this.cacheSize = cacheSize;
        this.onStatus = onStatus || (() => {});
        this.onAnswer = onAnswer || (() => {});
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

        const fp = fingerprint(question);
        const norm = normalizeText(question);
        if (!force) {
            const cached = this._cacheLookup(fp, norm, settings.duplicateThreshold || 0.85);
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

        const styleHint = ALLOWED_STYLES.has(style) ? style : 'natural';
        const ctx = settings.ivContext || {};
        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            {
                role: 'user',
                content: buildUserPrompt({
                    originalTranscript: question,
                    vietnameseTranslation,
                    detectedLanguage,
                    targetLanguage: ctx.targetLanguage,
                    languageLevel: ctx.languageLevel,
                    beruf: ctx.beruf,
                    companyName: ctx.companyName,
                    userBackground: ctx.userBackground,
                    strengths: ctx.strengths,
                    workExperience: ctx.workExperience,
                    style: styleHint,
                }),
            },
        ];

        const controller = new AbortController();
        this._inflight = { controller, key: fp };
        this.onStatus('loading');
        let result;
        try {
            result = await chatCompletionJson({
                baseUrl: settings.gptBaseUrl,
                apiKey,
                model: settings.gptModel,
                messages,
                temperature: styleHint === 'natural' ? 0.4 : 0.6,
                signal: controller.signal,
            });
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

        const answer = this._normalizeAnswer(result.json, question);
        this._cachePut(fp, norm, answer);
        this.lastQuestion = question;
        this.lastResult = answer;
        this.onAnswer(answer);
        this.onStatus(answer.is_interview_question ? 'answer' : 'not-question');
        return answer;
    }

    /**
     * Hook into the QuestionDetectionPipeline. Called once per debounced,
     * deduped question detection.
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
        } catch (e) {
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

    _normalizeAnswer(json, originalQuestion) {
        const out = {
            is_interview_question: !!json?.is_interview_question,
            detected_question: typeof json?.detected_question === 'string' ? json.detected_question : originalQuestion,
            question_vi: typeof json?.question_vi === 'string' ? json.question_vi : '',
            short_answer: typeof json?.short_answer === 'string' ? json.short_answer : '',
            full_answer: typeof json?.full_answer === 'string' ? json.full_answer : '',
            answer_vi: typeof json?.answer_vi === 'string' ? json.answer_vi : '',
            important_vocabulary: Array.isArray(json?.important_vocabulary)
                ? json.important_vocabulary
                    .filter((v) => v && typeof v === 'object')
                    .map((v) => ({ word: String(v.word || ''), meaning_vi: String(v.meaning_vi || '') }))
                    .filter((v) => v.word)
                : [],
            confidence: typeof json?.confidence === 'number' ? json.confidence : 0,
            reason: typeof json?.reason === 'string' ? json.reason : '',
        };
        return out;
    }

    _cacheLookup(fp, norm, threshold) {
        for (const entry of this._cache) {
            if (entry.fp === fp) return entry;
            if (isSimilar(entry.normalized, norm, threshold)) return entry;
        }
        return null;
    }

    _cachePut(fp, norm, answer) {
        this._cache.unshift({ fp, normalized: norm, answer });
        while (this._cache.length > this.cacheSize) this._cache.pop();
    }
}
