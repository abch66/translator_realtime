/**
 * interviewHistoryStorage — local persistence for the interview history.
 *
 * Each item captures the full lifecycle of a question handled by the
 * Interview Assistant: original transcript, translation, generated prompt
 * and (optionally) the user-pasted ChatGPT answer.
 *
 * Stored entirely in localStorage; no network, no backend changes.
 */

const STORAGE_KEY = 'translator_interview_history_v1';
const MAX_ITEMS = 200;

function safeParse(raw, fallback) {
    if (!raw) return fallback;
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
    } catch (e) { /* fall through */ }
    return fallback;
}

function makeId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `iv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

class InterviewHistoryStorage {
    constructor(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
        this._storage = storage;
        this._listeners = new Set();
        this._items = this._load();
    }

    _load() {
        if (!this._storage) return [];
        return safeParse(this._storage.getItem(STORAGE_KEY), []);
    }

    _persist() {
        if (!this._storage) return;
        try {
            this._storage.setItem(STORAGE_KEY, JSON.stringify(this._items));
        } catch (e) {
            console.warn('[interviewHistory] persist failed:', e);
        }
        for (const cb of this._listeners) {
            try { cb(this.list()); } catch (e) { console.error(e); }
        }
    }

    list() {
        return this._items.slice();
    }

    add(entry) {
        const item = {
            id: makeId(),
            createdAt: new Date().toISOString(),
            mode: entry.mode || 'interview', // 'translator' | 'interview' | 'combined'
            originalQuestion: entry.originalQuestion || '',
            sourceLanguage: entry.sourceLanguage || 'unknown',
            vietnameseTranslation: entry.vietnameseTranslation || '',
            generatedPrompt: entry.generatedPrompt || '',
            chatGptAnswer: entry.chatGptAnswer || '',
            targetLanguage: entry.targetLanguage || '',
            interviewType: entry.interviewType || '',
            languageLevel: entry.languageLevel || '',
            answerLength: entry.answerLength || '',
            answerStyle: entry.answerStyle || '',
            notes: entry.notes || '',
        };
        this._items.unshift(item);
        if (this._items.length > MAX_ITEMS) {
            this._items.length = MAX_ITEMS;
        }
        this._persist();
        return item;
    }

    update(id, patch) {
        const idx = this._items.findIndex((i) => i.id === id);
        if (idx < 0) return null;
        this._items[idx] = { ...this._items[idx], ...patch };
        this._persist();
        return this._items[idx];
    }

    remove(id) {
        const before = this._items.length;
        this._items = this._items.filter((i) => i.id !== id);
        if (this._items.length !== before) this._persist();
    }

    clear() {
        this._items = [];
        this._persist();
    }

    search(query) {
        if (!query) return this.list();
        const q = String(query).toLowerCase();
        return this._items.filter((item) => {
            return (
                (item.originalQuestion || '').toLowerCase().includes(q) ||
                (item.vietnameseTranslation || '').toLowerCase().includes(q) ||
                (item.generatedPrompt || '').toLowerCase().includes(q) ||
                (item.chatGptAnswer || '').toLowerCase().includes(q) ||
                (item.notes || '').toLowerCase().includes(q)
            );
        });
    }

    onChange(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    exportJson() {
        return JSON.stringify(this._items, null, 2);
    }

    exportText() {
        return this._items
            .map((item, idx) => {
                return [
                    `### #${idx + 1} — ${item.createdAt} [${item.mode}]`,
                    `Question (${item.sourceLanguage}): ${item.originalQuestion}`,
                    `Vietnamese: ${item.vietnameseTranslation}`,
                    `Interview type: ${item.interviewType} | Target: ${item.targetLanguage} | Level: ${item.languageLevel}`,
                    '--- Prompt ---',
                    item.generatedPrompt,
                    '--- ChatGPT Answer ---',
                    item.chatGptAnswer || '(none)',
                    '',
                ].join('\n');
            })
            .join('\n');
    }
}

export const interviewHistoryStorage = new InterviewHistoryStorage();
