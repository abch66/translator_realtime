/**
 * duplicateQuestionGuard — keeps the auto-detect pipeline from re-emitting
 * the same question twice in a row.
 *
 * Strategy:
 *   1. Maintain a small ring buffer of the most recent normalized question
 *      fingerprints (exact-match O(1) check).
 *   2. If the fingerprint is new, run a Dice-similarity comparison against
 *      the recent items. Anything ≥ threshold (default 0.85) is considered
 *      a duplicate.
 */

import { normalizeText, diceSimilarity } from '../../utils/textSimilarity.js';
import { fingerprint } from '../../utils/hashUtils.js';

const DEFAULT_RING_SIZE = 12;

export class DuplicateQuestionGuard {
    constructor({ threshold = 0.85, ringSize = DEFAULT_RING_SIZE } = {}) {
        this.threshold = threshold;
        this.ringSize = ringSize;
        this._fingerprints = new Set();
        this._recent = []; // [{ fp, normalized, raw }]
    }

    setThreshold(threshold) {
        if (typeof threshold === 'number' && threshold >= 0 && threshold <= 1) {
            this.threshold = threshold;
        }
    }

    /** Returns true if `text` should be considered a duplicate. */
    isDuplicate(text) {
        const normalized = normalizeText(text);
        if (!normalized) return true; // empty input — treat as already seen
        const fp = fingerprint(normalized);
        if (this._fingerprints.has(fp)) return true;
        for (const item of this._recent) {
            if (diceSimilarity(normalized, item.normalized) >= this.threshold) {
                return true;
            }
        }
        return false;
    }

    /** Record a question as "seen". */
    remember(text) {
        const normalized = normalizeText(text);
        if (!normalized) return;
        const fp = fingerprint(normalized);
        if (this._fingerprints.has(fp)) return;
        this._fingerprints.add(fp);
        this._recent.push({ fp, normalized, raw: text });
        while (this._recent.length > this.ringSize) {
            const dropped = this._recent.shift();
            this._fingerprints.delete(dropped.fp);
        }
    }

    reset() {
        this._fingerprints.clear();
        this._recent.length = 0;
    }
}
