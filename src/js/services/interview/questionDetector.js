/**
 * questionDetector — extracts likely interview questions out of a stream
 * of transcript text.
 *
 * A snippet is considered a question if any of these hold:
 *   - it ends with `?` (or contains `?` inside the matching sentence)
 *   - it starts with one of the multilingual cue phrases (English, German,
 *     Vietnamese) defined in languageUtils.QUESTION_CUES
 *   - it starts with a single-word interrogative even without `?`
 *
 * Behaviour notes (per project spec):
 *   - we DO NOT fire on every word; the caller is expected to debounce
 *     transcript updates and only call `detectLatestQuestion()` once the
 *     transcript has been quiet for `detectionDebounceMs` (default 2s)
 *   - we enforce a `minQuestionLength` so single-word fragments do not
 *     get treated as questions
 *   - we always return only ONE candidate — the most recent question
 *     present in the transcript
 *   - duplicate handling is the caller's responsibility (DuplicateQuestionGuard)
 */

import { QUESTION_CUES, detectLanguage } from '../../utils/languageUtils.js';
import { normalizeText } from '../../utils/textSimilarity.js';

const DEFAULT_MIN_LEN = 10;

const ALL_CUES = Object.values(QUESTION_CUES).flat();

const SENTENCE_SPLIT = /(?<=[.!?。！？])\s+|\n+/;

function startsWithCue(normalizedSentence) {
    for (const cue of ALL_CUES) {
        if (normalizedSentence.startsWith(cue + ' ') || normalizedSentence === cue) {
            return true;
        }
    }
    return false;
}

function looksLikeQuestion(sentence, minLen) {
    const trimmed = String(sentence || '').trim();
    if (trimmed.length < minLen) return false;
    if (trimmed.includes('?') || trimmed.includes('？')) return true;
    const norm = normalizeText(trimmed);
    if (!norm) return false;
    return startsWithCue(norm);
}

/**
 * Split a transcript blob into candidate sentences while still preserving
 * the original (un-normalized) text for output.
 */
export function splitSentences(text) {
    if (!text) return [];
    return String(text)
        .split(SENTENCE_SPLIT)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Find all questions present in `text`. Returned items are the original
 * substring plus a detected language code.
 *
 * @returns {Array<{text:string, language:string}>}
 */
export function findQuestions(text, opts = {}) {
    const minLen = opts.minQuestionLength || DEFAULT_MIN_LEN;
    const out = [];
    for (const sentence of splitSentences(text)) {
        if (looksLikeQuestion(sentence, minLen)) {
            out.push({ text: sentence, language: detectLanguage(sentence) });
        }
    }
    return out;
}

/** Convenience: return only the most recent question, or null. */
export function detectLatestQuestion(text, opts) {
    const all = findQuestions(text, opts);
    return all.length ? all[all.length - 1] : null;
}

/**
 * Wraps a detection pipeline: feed it transcript updates, it will fire the
 * provided callback at most once per "quiet period" with the latest
 * question (if any).
 */
export class QuestionDetectionPipeline {
    constructor({
        debounceMs = 2000,
        minQuestionLength = DEFAULT_MIN_LEN,
        onStatusChange = () => {},
        onQuestion = () => {},
    } = {}) {
        this.debounceMs = debounceMs;
        this.minQuestionLength = minQuestionLength;
        this.onStatusChange = onStatusChange;
        this.onQuestion = onQuestion;
        this._timer = null;
        this._lastTranscript = '';
        this._enabled = false;
    }

    setEnabled(flag) {
        this._enabled = !!flag;
        if (!flag && this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._setStatus(flag ? 'Listening for questions' : 'Disabled');
    }

    setDebounceMs(ms) {
        if (typeof ms === 'number' && ms >= 250) this.debounceMs = ms;
    }

    setMinQuestionLength(len) {
        if (typeof len === 'number' && len > 0) this.minQuestionLength = len;
    }

    pushTranscript(text) {
        if (!this._enabled) return;
        this._lastTranscript = String(text || '');
        this._setStatus('Waiting for complete question');
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => this._tick(), this.debounceMs);
    }

    flush() {
        if (this._timer) clearTimeout(this._timer);
        this._tick();
    }

    _tick() {
        this._timer = null;
        const candidate = detectLatestQuestion(this._lastTranscript, {
            minQuestionLength: this.minQuestionLength,
        });
        if (candidate) {
            this._setStatus('Question detected');
            try { this.onQuestion(candidate); } catch (e) { console.error(e); }
        } else {
            this._setStatus('No question detected');
        }
    }

    _setStatus(status) {
        try { this.onStatusChange(status); } catch (e) { console.error(e); }
    }
}
