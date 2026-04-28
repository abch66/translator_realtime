/**
 * Tiny helpers for displaying API keys safely in the UI.
 * The real key never leaves localStorage / the network call we issue.
 */

export function maskApiKey(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed) return '';
    if (trimmed.length <= 8) return '****';
    const head = trimmed.slice(0, 3);
    const tail = trimmed.slice(-4);
    return `${head}-****${tail}`;
}

export function looksLikeKey(raw) {
    return typeof raw === 'string' && raw.trim().length >= 8;
}
