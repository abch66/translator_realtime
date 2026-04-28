/**
 * interviewSettingsStorage — persist Interview Assistant settings in the
 * browser's localStorage. The original my-translator app stores its core
 * settings in the Rust backend; we deliberately keep the new interview
 * settings on the frontend so this extension does NOT require any change
 * to the Rust schema (avoids breaking the auto-generated migration).
 *
 * IMPORTANT: never store ChatGPT cookies, sessions, or passwords here.
 */

const STORAGE_KEY = 'translator_interview_settings_v1';

export const DEFAULT_INTERVIEW_SETTINGS = {
    enabled: true,
    autoDetectQuestion: true,
    autoGenerateAnswer: false, // we use ChatGPT Account Manual Mode
    combinedMode: true, // detect questions while the translator is running
    detectionDebounceMs: 1000, // 800-1200ms — fast generate window
    duplicateThreshold: 0.85,
    minQuestionLength: 10,

    // ChatGPT manual-mode settings (we never automate ChatGPT).
    chatGptUrl: 'https://chatgpt.com',
    openInDefaultBrowser: true,
    autoCopyGeneratedPrompt: false,
    savePromptsToHistory: true,
    savePastedAnswersToHistory: true,

    // Defaults for the prompt template.
    targetLanguage: 'Vietnamese', // 'Vietnamese' | 'English' | 'German'
    answerLength: 'Medium', // 'Short' | 'Medium' | 'Detailed'
    languageLevel: 'B1', // 'Simple' | 'A2' | 'B1' | 'B2' | 'Professional'
    answerStyle: 'Natural', // 'Natural' | 'Professional' | 'Confident' | 'Humble'
    interviewType: 'Job interview',
    userContext: '',

    // Combined Mode — GPT API integration (NOT a ChatGPT-account flow).
    // We call ${gptBaseUrl}/chat/completions with the user's API key.
    gptApiKey: '',
    gptBaseUrl: 'https://api.openai.com/v1',
    gptModel: 'gpt-4o-mini',
    gptMinWords: 5,
    gptMaxTokens: 600, // cap output ~3-6 sentences
    combinedAutoCall: true, // call GPT automatically when a question is detected
    combinedStreaming: true, // stream tokens to render answer as it arrives

    // Interview-context defaults aligned with the Ausbildung use-case from the spec.
    ivContext: {
        targetLanguage: 'Deutsch', // 'Deutsch' | 'English' | 'Vietnamese'
        languageLevel: 'A2-B1',    // 'A1' | 'A2' | 'A2-B1' | 'B1' | 'B2'
        beruf: 'Maschinen- und Anlagenführer',
        companyName: 'Teledoor',
        userBackground: '',
        strengths: '',
        workExperience: '',
    },
};

function safeParse(raw) {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) {
        console.warn('[interviewSettings] failed to parse stored settings:', e);
    }
    return null;
}

class InterviewSettingsStorage {
    constructor(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
        this._storage = storage;
        this._listeners = new Set();
        this._cache = this._load();
    }

    _load() {
        if (!this._storage) return { ...DEFAULT_INTERVIEW_SETTINGS, ivContext: { ...DEFAULT_INTERVIEW_SETTINGS.ivContext } };
        const parsed = safeParse(this._storage.getItem(STORAGE_KEY)) || {};
        const ivContext = { ...DEFAULT_INTERVIEW_SETTINGS.ivContext, ...(parsed.ivContext || {}) };
        return { ...DEFAULT_INTERVIEW_SETTINGS, ...parsed, ivContext };
    }

    get() {
        return { ...this._cache };
    }

    update(patch) {
        // Deep-merge nested ivContext so partial updates don't drop sibling keys.
        const merged = { ...this._cache, ...patch };
        if (patch && patch.ivContext) {
            merged.ivContext = { ...this._cache.ivContext, ...patch.ivContext };
        }
        this._cache = merged;
        if (this._storage) {
            try {
                this._storage.setItem(STORAGE_KEY, JSON.stringify(this._cache));
            } catch (e) {
                console.warn('[interviewSettings] failed to persist:', e);
            }
        }
        for (const cb of this._listeners) {
            try { cb(this.get()); } catch (e) { console.error(e); }
        }
        return this.get();
    }

    reset() {
        return this.update({ ...DEFAULT_INTERVIEW_SETTINGS });
    }

    onChange(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }
}

export const interviewSettingsStorage = new InterviewSettingsStorage();
