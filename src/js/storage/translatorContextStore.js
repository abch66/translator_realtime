/**
 * translatorContextStore — single source of truth for the live translator
 * state that the Interview Assistant (Combined Mode) needs to build a
 * context-aware GPT prompt.
 *
 * The Combined Mode pipeline used to receive only the freshly-detected
 * question. That is too thin: the GPT model can't disambiguate "And
 * yourself?" without knowing what was said before. This store aggregates
 * the running originals + translations + detection events into a single
 * `translatorContext` snapshot that the Interview Assistant reads from.
 *
 * Design:
 *   - in-memory only; nothing here is persisted to localStorage (transient
 *     transcript shouldn't survive a restart, and it might be sensitive).
 *   - bounded: we keep at most `MAX_SEGMENTS` per channel and cap the
 *     concatenated transcript at `MAX_TRANSCRIPT_CHARS` to avoid blowing
 *     past the GPT context window for very long sessions.
 *   - lastUpdatedAt is bumped on every state change so consumers can
 *     debounce on "fresh enough" data.
 */

const MAX_SEGMENTS = 80; // ring buffer per channel (originals / translations)
const RECENT_SEGMENT_COUNT = 6;
export const MAX_TRANSCRIPT_CHARS = 8000; // cap fed to GPT

function nowTs() {
    return Date.now();
}

function joinSegments(segments) {
    if (!segments.length) return '';
    return segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
}

function tailWithLimit(text, limit = MAX_TRANSCRIPT_CHARS) {
    if (!text) return '';
    if (text.length <= limit) return text;
    // Keep the suffix — that's the most recent context. Trim to the next
    // word boundary so we don't slice in the middle of a multi-byte char or
    // a German compound word.
    const sliced = text.slice(text.length - limit);
    const firstSpace = sliced.indexOf(' ');
    return firstSpace > 0 ? sliced.slice(firstSpace + 1) : sliced;
}

class TranslatorContextStore {
    constructor() {
        this._originals = []; // [{ text, language, ts }]
        this._translations = []; // [{ text, ts }]
        this._sourceLanguage = '';
        this._targetLanguage = '';
        this._detectedQuestion = null; // { text, language, ts } | null
        this._isListening = false;
        this._lastUpdatedAt = 0;
        this._listeners = new Set();
    }

    onChange(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    _emit() {
        this._lastUpdatedAt = nowTs();
        const snap = this.get();
        for (const cb of this._listeners) {
            try { cb(snap); } catch (e) { console.error('[translatorContext]', e); }
        }
    }

    pushOriginal(text, language) {
        const t = String(text || '').trim();
        if (!t) return;
        this._originals.push({ text: t, language: language || '', ts: nowTs() });
        if (this._originals.length > MAX_SEGMENTS) this._originals.shift();
        if (language && !this._sourceLanguage) this._sourceLanguage = language;
        this._emit();
    }

    pushTranslation(text) {
        const t = String(text || '').trim();
        if (!t) return;
        this._translations.push({ text: t, ts: nowTs() });
        if (this._translations.length > MAX_SEGMENTS) this._translations.shift();
        this._emit();
    }

    setSourceLanguage(code) {
        if (!code || code === this._sourceLanguage) return;
        this._sourceLanguage = String(code);
        this._emit();
    }

    setTargetLanguage(code) {
        if (!code || code === this._targetLanguage) return;
        this._targetLanguage = String(code);
        this._emit();
    }

    setListening(flag) {
        const next = !!flag;
        if (next === this._isListening) return;
        this._isListening = next;
        this._emit();
    }

    setDetectedQuestion(text, language) {
        const t = String(text || '').trim();
        if (!t) {
            if (this._detectedQuestion === null) return;
            this._detectedQuestion = null;
            this._emit();
            return;
        }
        this._detectedQuestion = { text: t, language: language || '', ts: nowTs() };
        this._emit();
    }

    /**
     * Reset live state — call when the user starts a new session so we
     * don't bleed a stale transcript across sessions. We deliberately keep
     * sourceLanguage/targetLanguage since those track user settings.
     */
    reset() {
        this._originals = [];
        this._translations = [];
        this._detectedQuestion = null;
        this._isListening = false;
        this._emit();
    }

    /** Snapshot the current context for prompt construction. */
    get() {
        const fullTranscript = tailWithLimit(joinSegments(this._originals));
        const fullVietnameseTranslation = tailWithLimit(joinSegments(this._translations));
        const recentOriginals = this._originals.slice(-RECENT_SEGMENT_COUNT);
        const recentSegments = recentOriginals.map((s, i) => {
            const tr = this._translations[this._translations.length - recentOriginals.length + i];
            return {
                text: s.text,
                translation: tr ? tr.text : '',
                language: s.language,
                ts: s.ts,
            };
        });
        const lastOriginal = this._originals.length
            ? this._originals[this._originals.length - 1]
            : null;
        const lastTranslation = this._translations.length
            ? this._translations[this._translations.length - 1]
            : null;
        return {
            sourceLanguage: this._sourceLanguage || (lastOriginal?.language || ''),
            targetLanguage: this._targetLanguage,
            fullTranscript,
            fullVietnameseTranslation,
            latestTranscriptSegment: lastOriginal ? lastOriginal.text : '',
            latestVietnameseSegment: lastTranslation ? lastTranslation.text : '',
            recentSegments,
            detectedQuestion: this._detectedQuestion ? { ...this._detectedQuestion } : null,
            timestamps: {
                latestOriginal: lastOriginal?.ts || 0,
                latestTranslation: lastTranslation?.ts || 0,
                detectedQuestion: this._detectedQuestion?.ts || 0,
                lastUpdatedAt: this._lastUpdatedAt,
            },
            isListening: this._isListening,
            lastUpdatedAt: this._lastUpdatedAt,
        };
    }

    /** Returns true once we have anything meaningful to feed GPT. */
    hasContext() {
        return this._originals.length > 0 || !!this._detectedQuestion;
    }
}

export const translatorContextStore = new TranslatorContextStore();
