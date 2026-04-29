/**
 * combinedAnswerService — drives Combined Mode.
 *
 * When BOTH the Translator and the Interview Assistant are active, each
 * detected question is fed to GPT (via the OpenAI-compatible REST API) and
 * a single concise answer is streamed back into the Interview Assistant
 * view.
 *
 * The service can run in two prompt modes:
 *   - **context-aware** (preferred): caller passes a `translatorContext`
 *     snapshot and we send the full transcript / translation / detected
 *     question / metadata so GPT can disambiguate ("And yourself?" only
 *     means something with the previous turn). This corresponds to the
 *     A–F output format described in the spec.
 *   - **legacy bare-question**: caller passes just `originalTranscript`
 *     (the manual "Generate Answer" button or older callers). Builds the
 *     short prompt asking for ONE concise answer.
 *
 * Anti-spam guarantees:
 *   - Caches the last N (~10) (question, style) pairs + their answers.
 *   - Skips the call if a near-duplicate question (Dice ≥ 0.85) is cached.
 *   - Skips the call if the question has fewer than `minWords` tokens.
 *   - Aborts in-flight requests when a fresher question arrives.
 */

import { chatCompletionStream, chatCompletion, GptClientError } from './gptClient.js';
import { fingerprint } from '../../utils/hashUtils.js';
import { isSimilar, normalizeText } from '../../utils/textSimilarity.js';

const ALLOWED_STYLES = new Set(['natural', 'simpler']);

/** Legacy single-answer system prompt (no transcript context). */
function buildLegacySystemPrompt({ targetLanguage = 'Deutsch', languageLevel = 'A2-B1' } = {}) {
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

function buildLegacyUserPrompt({ question, detectedLanguage, vietnameseTranslation, style, targetLanguage }) {
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

/**
 * Context-aware system prompt — the Combined Mode flagship prompt. Tells
 * GPT it is receiving real-time translator data and must reason over the
 * full conversation, not only the latest sentence.
 */
function buildContextSystemPrompt() {
    return [
        'You are an interview assistant. You receive real-time transcript and Vietnamese',
        'translation from a translator panel. Your job is to understand the full context,',
        'detect the actual interview question or implied question, and suggest a natural,',
        'honest, easy-to-speak answer. Use the full context, not only the latest sentence.',
        'Do not invent fake experience. Do not help with cheating, impersonation, or',
        'bypassing interview rules.',
    ].join(' ');
}

function placeholder(value) {
    const v = (value == null ? '' : String(value)).trim();
    return v || '(none)';
}

function formatRecentSegments(recent = []) {
    if (!recent.length) return '(none)';
    return recent
        .map((s, i) => {
            const idx = recent.length - i; // 1 = oldest in window, len = newest
            const tr = s.translation ? ` → ${s.translation}` : '';
            return `[${idx}] ${s.text}${tr}`;
        })
        .join('\n');
}

/**
 * Render the user-prompt template described in the spec. `ctx` should
 * already be a snapshot of the translator context. `meta` carries the
 * Interview Assistant's per-call settings.
 */
function buildContextUserPrompt({ ctx, meta, question }) {
    const lines = [];
    lines.push('Source language:');
    lines.push(placeholder(ctx.sourceLanguage));
    lines.push('');
    lines.push('Full transcript so far:');
    lines.push(placeholder(ctx.fullTranscript));
    lines.push('');
    lines.push('Full Vietnamese translation so far:');
    lines.push(placeholder(ctx.fullVietnameseTranslation));
    lines.push('');
    lines.push('Recent transcript segments:');
    lines.push(formatRecentSegments(ctx.recentSegments));
    lines.push('');
    lines.push('Latest transcript segment:');
    lines.push(placeholder(ctx.latestTranscriptSegment));
    lines.push('');
    lines.push('Latest Vietnamese translation:');
    lines.push(placeholder(ctx.latestVietnameseSegment));
    lines.push('');
    lines.push('Detected question, if any:');
    lines.push(placeholder(question || ctx.detectedQuestion?.text));
    lines.push('');
    lines.push('User background/context:');
    lines.push(placeholder(meta.userContext));
    lines.push('');
    lines.push('Interview type:');
    lines.push(placeholder(meta.interviewType));
    lines.push('');
    lines.push('Target answer language:');
    lines.push(placeholder(meta.targetLanguage));
    lines.push('');
    lines.push('Answer length:');
    lines.push(placeholder(meta.answerLength));
    lines.push('');
    lines.push('Language level:');
    lines.push(placeholder(meta.languageLevel));
    lines.push('');
    lines.push('Answer style:');
    lines.push(placeholder(meta.answerStyle));
    lines.push('');
    lines.push('Task:');
    lines.push('1. Analyze the full conversation context.');
    lines.push('2. Identify the actual question or implied question the user needs to answer.');
    lines.push('3. Explain the question in Vietnamese.');
    lines.push('4. Explain what the interviewer wants to know.');
    lines.push('5. Suggest a natural answer in the target language.');
    lines.push('6. Keep the answer suitable for the selected language level.');
    lines.push('7. If the target language is not Vietnamese, provide Vietnamese meaning.');
    lines.push('8. Add useful phrases if the target language is English or German.');
    lines.push('9. If there is not enough information to answer, ask for the missing information or provide a safe general answer.');
    lines.push('');
    lines.push('Output format:');
    lines.push('A. Context summary in Vietnamese:');
    lines.push('...');
    lines.push('');
    lines.push('B. Detected or implied question:');
    lines.push('...');
    lines.push('');
    lines.push('C. What the interviewer wants to know:');
    lines.push('...');
    lines.push('');
    lines.push('D. Suggested answer:');
    lines.push('...');
    lines.push('');
    lines.push('E. Vietnamese meaning:');
    lines.push('...');
    lines.push('');
    lines.push('F. Useful phrases:');
    lines.push('...');
    return lines.join('\n');
}

/**
 * Resolve the "question" the answer is keyed on. Used both for cache
 * lookups and for the legacy prompt path.
 */
function resolveQuestion({ originalTranscript, translatorContext }) {
    const q = (originalTranscript || '').trim();
    if (q) return q;
    if (translatorContext?.detectedQuestion?.text) {
        return translatorContext.detectedQuestion.text.trim();
    }
    if (translatorContext?.latestTranscriptSegment) {
        return translatorContext.latestTranscriptSegment.trim();
    }
    return '';
}

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
        this._cache = []; // [{ fp, normalized, style, answer }]
        this._inflight = null; // { controller, key }
        this.lastQuestion = null;
        this.lastResult = null;
    }

    /**
     * Request an answer.
     *
     * Preferred shape (context-aware):
     *   generate({ translatorContext, style, force, ...meta })
     * Legacy shape (bare question):
     *   generate({ originalTranscript, vietnameseTranslation, detectedLanguage, style, force })
     */
    async generate({
        translatorContext,
        originalTranscript,
        vietnameseTranslation,
        detectedLanguage,
        style = 'natural',
        force = false,
        // Per-call meta overrides (Section C / D values from the panel).
        userContext,
        interviewType,
        targetLanguage,
        answerLength,
        answerStyle,
        languageLevel,
    } = {}) {
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
        const question = resolveQuestion({ originalTranscript, translatorContext });
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
        // Honour the panel's per-call meta (Section C/D selectors) but fall
        // back to the persisted ivContext so missing values still get filled.
        const meta = {
            userContext: userContext ?? ctx.userBackground ?? '',
            interviewType: interviewType ?? '',
            targetLanguage: targetLanguage ?? ctx.targetLanguage ?? 'Deutsch',
            answerLength: answerLength ?? '',
            answerStyle: answerStyle ?? (styleHint === 'simpler' ? 'Simpler' : 'Natural'),
            languageLevel: languageLevel ?? ctx.languageLevel ?? 'A2-B1',
        };

        const useContextPrompt = settings.useTranslatorContext !== false
            && translatorContext
            && (translatorContext.fullTranscript || translatorContext.latestTranscriptSegment || translatorContext.detectedQuestion);

        let systemPrompt;
        let userPrompt;
        if (useContextPrompt) {
            systemPrompt = buildContextSystemPrompt();
            userPrompt = buildContextUserPrompt({
                ctx: translatorContext,
                meta,
                question,
            });
        } else {
            systemPrompt = buildLegacySystemPrompt({
                targetLanguage: meta.targetLanguage,
                languageLevel: meta.languageLevel,
            });
            userPrompt = buildLegacyUserPrompt({
                question,
                detectedLanguage,
                vietnameseTranslation,
                style: styleHint,
                targetLanguage: meta.targetLanguage,
            });
        }
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
            language: detectedLanguage || translatorContext?.detectedQuestion?.language || '',
            style: styleHint,
            createdAt: Date.now(),
            promptMode: useContextPrompt ? 'context' : 'legacy',
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
    async onDetectedQuestion({ text, language, vietnameseTranslation, translatorContext } = {}) {
        const settings = this.getSettings();
        if (!settings.combinedMode || !settings.combinedAutoCall) return null;
        if (!settings.gptApiKey) {
            this.onStatus('missing-key');
            return null;
        }
        try {
            return await this.generate({
                translatorContext,
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
