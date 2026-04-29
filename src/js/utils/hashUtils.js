/**
 * hashUtils — fast, dependency-free hashing for de-duplication.
 *
 * We do NOT need cryptographic strength here; we only want a short stable
 * fingerprint of a normalized question so the guard can do O(1) lookup of
 * exact duplicates before falling back to the more expensive similarity
 * check.
 */

/**
 * 32-bit FNV-1a hash, returned as an unsigned hex string.
 */
export function fnv1aHash(input) {
    if (input == null) return '00000000';
    const str = String(input);
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        // 32-bit FNV prime multiply, kept in unsigned range
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * Generate a short fingerprint suitable for use as a Map key for a piece
 * of detected text. Uses the normalized text length as additional entropy
 * to reduce collisions for very short strings.
 */
export function fingerprint(input) {
    const safe = String(input || '');
    return `${safe.length.toString(16)}-${fnv1aHash(safe)}`;
}
