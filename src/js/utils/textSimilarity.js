/**
 * textSimilarity — light-weight string similarity utilities.
 *
 * Used by the duplicate-question guard to decide whether a newly-detected
 * question is "the same as" the previous one. We avoid heavy NLP and just
 * combine a normalized exact-match check with a Dice/bigram coefficient,
 * which works well for short interview-style questions across English,
 * German and Vietnamese.
 */

/**
 * Normalize a string for similarity comparison:
 *  - lowercase
 *  - strip diacritics (NFD + combining mark removal) so "Vì sao" ≈ "vi sao"
 *  - collapse runs of whitespace
 *  - remove most punctuation (keep alphanumerics + spaces)
 */
export function normalizeText(input) {
    if (!input) return '';
    return String(input)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s\u00c0-\u024f\u1e00-\u1eff]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function bigrams(text) {
    const out = new Map();
    if (text.length < 2) {
        if (text.length === 1) out.set(text, 1);
        return out;
    }
    for (let i = 0; i < text.length - 1; i++) {
        const bg = text.slice(i, i + 2);
        out.set(bg, (out.get(bg) || 0) + 1);
    }
    return out;
}

/**
 * Dice coefficient on character bigrams of the normalized strings.
 * Returns a number in [0, 1].
 */
export function diceSimilarity(a, b) {
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (!na && !nb) return 1;
    if (!na || !nb) return 0;
    if (na === nb) return 1;

    const ba = bigrams(na);
    const bb = bigrams(nb);

    let intersection = 0;
    let totalA = 0;
    let totalB = 0;
    for (const v of ba.values()) totalA += v;
    for (const v of bb.values()) totalB += v;

    for (const [bg, count] of ba.entries()) {
        const other = bb.get(bg);
        if (other) intersection += Math.min(count, other);
    }

    if (totalA + totalB === 0) return 0;
    return (2 * intersection) / (totalA + totalB);
}

/**
 * Convenience: returns true if `a` and `b` are "similar enough" given a
 * threshold (default 0.85, matching the spec).
 */
export function isSimilar(a, b, threshold = 0.85) {
    return diceSimilarity(a, b) >= threshold;
}
