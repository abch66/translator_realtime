/**
 * languageUtils — helpers used by the interview module to detect the
 * language of a question and to expose the multilingual question-cue lists
 * required by the spec.
 *
 * The detector intentionally favours the three languages this project
 * cares about (English / German / Vietnamese) but degrades gracefully to
 * "unknown" when nothing matches.
 */

export const QUESTION_CUES = {
    en: [
        'what', 'why', 'how', 'when', 'where', 'who', 'which',
        'can you', 'could you', 'do you', 'did you', 'have you',
        'are you', 'tell me about',
    ],
    de: [
        'warum', 'wie', 'wann', 'wo', 'wer', 'was', 'welche',
        'können sie', 'kannst du', 'haben sie', 'sind sie',
        'erzählen sie',
    ],
    vi: [
        'tại sao', 'vì sao', 'như thế nào', 'khi nào', 'ở đâu',
        'ai', 'cái gì', 'bạn có thể', 'bạn đã', 'hãy kể',
        'hãy giới thiệu',
    ],
};

const VI_DIACRITICS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const DE_LETTERS = /[äöüß]/i;
const COMMON_DE_WORDS = /\b(ich|sie|der|die|das|und|nicht|warum|wie|wann|wo|wer|was|welche|können|kannst|haben|sind|erzählen|für|über|mein|deine|deinen|sein|seine|sehr|gut|bitte|danke|ja|nein|kein|keine|aber|auch)\b/i;
const COMMON_EN_WORDS = /\b(the|and|you|your|are|is|do|did|have|has|can|could|why|how|what|when|where|who|tell|me|about|with|for|to|of|in|on|that|this|it)\b/i;
const COMMON_VI_WORDS = /\b(bạn|tôi|của|và|là|có|không|được|cho|với|trong|đã|sẽ|sao|tại|vì|hãy|kể|giới|thiệu|gì|nào|đâu|ai)\b/i;

/**
 * Best-effort language detection for a short snippet.
 * Returns 'en' | 'de' | 'vi' | 'unknown'.
 */
export function detectLanguage(text) {
    if (!text) return 'unknown';
    const lower = String(text).toLowerCase();

    // Strong signals first.
    if (VI_DIACRITICS.test(lower)) return 'vi';
    if (DE_LETTERS.test(lower)) return 'de';

    // Fall back to common-word frequency.
    const scores = {
        en: (lower.match(COMMON_EN_WORDS) || []).length,
        de: (lower.match(COMMON_DE_WORDS) || []).length,
        vi: (lower.match(COMMON_VI_WORDS) || []).length,
    };

    let best = 'unknown';
    let bestScore = 0;
    for (const [lang, score] of Object.entries(scores)) {
        if (score > bestScore) {
            best = lang;
            bestScore = score;
        }
    }
    return bestScore > 0 ? best : 'unknown';
}

const LANG_LABELS = {
    en: 'English',
    de: 'German',
    vi: 'Vietnamese',
    unknown: 'Unknown',
};

export function languageLabel(code) {
    return LANG_LABELS[code] || code || 'Unknown';
}
