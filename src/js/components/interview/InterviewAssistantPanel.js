/**
 * InterviewAssistantPanel — wires the static markup defined in index.html
 * (the `#interview-view` panel) to the interview services.
 *
 * The panel implements the spec's "ChatGPT Account Manual Mode" workflow:
 *   1. user types a question (or pulls one from the latest transcript)
 *   2. user picks answer settings + supplies personal context
 *   3. Generate Prompt → renders the full prompt in a read-only textarea
 *   4. Copy Prompt + Open ChatGPT → user pastes prompt into ChatGPT in
 *      their own browser session
 *   5. user pastes the ChatGPT answer back into the panel and saves it
 *      to the local interview history
 *
 * NOTE: this module never touches ChatGPT cookies, sessions, or the
 * ChatGPT website itself. It only opens the public chatgpt.com URL via
 * the user's default browser through the Tauri opener plugin (or a
 * regular `window.open` fallback).
 */

import { buildInterviewPrompt } from '../../services/interview/promptBuilder.js';
import { QuestionDetectionPipeline } from '../../services/interview/questionDetector.js';
import { DuplicateQuestionGuard } from '../../services/interview/duplicateQuestionGuard.js';
import { interviewHistoryService } from '../../services/interview/interviewHistoryService.js';
import { CombinedAnswerService } from '../../services/interview/combinedAnswerService.js';
import { interviewSettingsStorage } from '../../storage/interviewSettingsStorage.js';
import { detectLanguage, languageLabel } from '../../utils/languageUtils.js';
import { maskApiKey } from '../../utils/secretUtils.js';

const TARGET_LANG_OPTIONS = ['Vietnamese', 'English', 'German'];
const ANSWER_LENGTH_OPTIONS = ['Short', 'Medium', 'Detailed'];
const LANGUAGE_LEVEL_OPTIONS = ['Simple', 'A2', 'B1', 'B2', 'Professional'];
const ANSWER_STYLE_OPTIONS = ['Natural', 'Professional', 'Confident', 'Humble'];
const INTERVIEW_TYPE_OPTIONS = [
    'Job interview',
    'Ausbildung interview',
    'University interview',
    'Visa interview',
    'General interview',
];

function $(id) {
    return document.getElementById(id);
}

function fillSelect(select, options, current) {
    if (!select) return;
    select.innerHTML = '';
    for (const opt of options) {
        const el = document.createElement('option');
        el.value = opt;
        el.textContent = opt;
        if (opt === current) el.selected = true;
        select.appendChild(el);
    }
}

export class InterviewAssistantPanel {
    constructor({ getLatestTranscript, openExternal, isTranslatorRunning } = {}) {
        this.getLatestTranscript = getLatestTranscript || (() => '');
        this.openExternal = openExternal || ((url) => window.open(url, '_blank'));
        this.isTranslatorRunning = isTranslatorRunning || (() => false);
        this._currentEntryId = null;
        this._lastDetectedQuestion = null;
        this._lastCombinedQuestion = null;

        this.guard = new DuplicateQuestionGuard({
            threshold: interviewSettingsStorage.get().duplicateThreshold,
        });
        this.pipeline = new QuestionDetectionPipeline({
            debounceMs: interviewSettingsStorage.get().detectionDebounceMs,
            minQuestionLength: interviewSettingsStorage.get().minQuestionLength,
            onStatusChange: (status) => this._setDetectionStatus(status),
            onQuestion: (q) => this._handleAutoDetectedQuestion(q),
        });

        this.combined = new CombinedAnswerService({
            getSettings: () => interviewSettingsStorage.get(),
            onStatus: (s) => this._setCombinedStatus(s),
            onAnswer: (a) => this._renderCombinedAnswer(a),
            onPartial: (p) => this._renderCombinedPartial(p),
            onError: (e) => this._renderCombinedError(e),
        });
        this._lastAutoDetectedFingerprint = null;

        interviewSettingsStorage.onChange((s) => this._applySettings(s));
        interviewHistoryService.onChange(() => this._renderHistory());
    }

    init() {
        const settings = interviewSettingsStorage.get();
        fillSelect($('iv-target-language'), TARGET_LANG_OPTIONS, settings.targetLanguage);
        fillSelect($('iv-answer-length'), ANSWER_LENGTH_OPTIONS, settings.answerLength);
        fillSelect($('iv-language-level'), LANGUAGE_LEVEL_OPTIONS, settings.languageLevel);
        fillSelect($('iv-answer-style'), ANSWER_STYLE_OPTIONS, settings.answerStyle);
        fillSelect($('iv-interview-type'), INTERVIEW_TYPE_OPTIONS, settings.interviewType);
        const userContextEl = $('iv-user-context');
        if (userContextEl) userContextEl.value = settings.userContext || '';

        $('iv-auto-detect-toggle')?.addEventListener('change', (e) => {
            interviewSettingsStorage.update({ autoDetectQuestion: !!e.target.checked });
        });
        $('iv-auto-detect-toggle') && ($('iv-auto-detect-toggle').checked = settings.autoDetectQuestion);

        $('iv-btn-use-transcript')?.addEventListener('click', () => this._useLatestTranscript());
        $('iv-btn-clear-question')?.addEventListener('click', () => this._clearQuestion());
        $('iv-btn-generate-prompt')?.addEventListener('click', () => this._generatePrompt());
        $('iv-btn-copy-prompt')?.addEventListener('click', () => this._copy('iv-generated-prompt'));
        $('iv-btn-open-chatgpt')?.addEventListener('click', () => this._openChatGpt());

        $('iv-btn-save-answer')?.addEventListener('click', () => this._saveAnswer());
        $('iv-btn-copy-answer')?.addEventListener('click', () => this._copy('iv-pasted-answer'));
        $('iv-btn-clear-answer')?.addEventListener('click', () => this._clearAnswer());

        // Combined Mode (GPT API) buttons.
        $('iv-btn-cb-generate')?.addEventListener('click', () => this._combinedGenerate());
        $('iv-btn-cb-regenerate')?.addEventListener('click', () => this._combinedGenerate({ force: true }));
        $('iv-btn-cb-simpler')?.addEventListener('click', () => this._combinedGenerate({ force: true, style: 'simpler' }));
        $('iv-btn-cb-copy')?.addEventListener('click', () => this._copyValue($('iv-cb-answer')?.textContent));
        $('iv-btn-cb-clear')?.addEventListener('click', () => this._combinedClear());

        $('iv-btn-split-toggle')?.addEventListener('click', () => this.toggleSplitView());

        // Inline answer-language + level pickers in Section H. Persist into
        // `ivContext` so the system prompt picks them up on the next call.
        const tlEl = $('iv-cb-target-language');
        const llEl = $('iv-cb-language-level');
        if (tlEl) {
            tlEl.value = settings.ivContext?.targetLanguage || 'Deutsch';
            tlEl.addEventListener('change', (e) => {
                interviewSettingsStorage.update({
                    ivContext: { targetLanguage: e.target.value },
                });
            });
        }
        if (llEl) {
            llEl.value = settings.ivContext?.languageLevel || 'A2-B1';
            llEl.addEventListener('change', (e) => {
                interviewSettingsStorage.update({
                    ivContext: { languageLevel: e.target.value },
                });
            });
        }

        // History controls.
        $('iv-history-search')?.addEventListener('input', () => this._renderHistory());
        $('iv-btn-history-clear')?.addEventListener('click', () => this._clearHistory());
        $('iv-btn-history-export-json')?.addEventListener('click', () => this._exportHistory('json'));
        $('iv-btn-history-export-txt')?.addEventListener('click', () => this._exportHistory('txt'));

        // Persist user context whenever changed (debounced).
        let ctxTimer = null;
        $('iv-user-context')?.addEventListener('input', (e) => {
            const v = e.target.value;
            if (ctxTimer) clearTimeout(ctxTimer);
            ctxTimer = setTimeout(() => {
                interviewSettingsStorage.update({ userContext: v });
            }, 400);
        });

        // Persist dropdowns immediately.
        $('iv-target-language')?.addEventListener('change', (e) => interviewSettingsStorage.update({ targetLanguage: e.target.value }));
        $('iv-answer-length')?.addEventListener('change', (e) => interviewSettingsStorage.update({ answerLength: e.target.value }));
        $('iv-language-level')?.addEventListener('change', (e) => interviewSettingsStorage.update({ languageLevel: e.target.value }));
        $('iv-answer-style')?.addEventListener('change', (e) => interviewSettingsStorage.update({ answerStyle: e.target.value }));
        $('iv-interview-type')?.addEventListener('change', (e) => interviewSettingsStorage.update({ interviewType: e.target.value }));

        // Update detection language/translation displays whenever question changes.
        $('iv-question-input')?.addEventListener('input', () => this._refreshQuestionMetadata());

        // Apply enabled-state.
        this._applySettings(settings);
        this._renderHistory();
        this._setDetectionStatus(settings.autoDetectQuestion ? 'Listening for questions' : 'Disabled');
    }

    /**
     * Called by the App with each transcript update so the auto-detect
     * pipeline can analyse the running text.
     */
    pushTranscript(text) {
        const settings = interviewSettingsStorage.get();
        if (!settings.enabled || !settings.autoDetectQuestion) return;
        // Combined Mode controls whether we feed the running transcript into
        // the question detector while the user is on a non-interview view.
        // When the interview panel is open we always feed it.
        const interviewActive = document.getElementById('interview-view')?.classList.contains('active');
        if (!interviewActive && !settings.combinedMode) return;
        this.pipeline.pushTranscript(text);
    }

    /**
     * Mirror live translator output into the split-view left column.
     * Called by the host app on every onTextUpdate from TranscriptUI.
     */
    pushSplitTranscript({ kind, text, language } = {}) {
        if (!text) return;
        if (kind === 'original' || kind === 'provisional') {
            const el = $('iv-split-original');
            if (el) el.textContent = text;
            if (language) this._setText('iv-split-language', language);
        } else if (kind === 'translation') {
            const el = $('iv-split-translation');
            if (el) el.textContent = text;
        }
        const status = $('iv-split-status');
        if (status) status.textContent = kind === 'provisional' ? 'listening…' : 'live';
    }

    setSplitView(on) {
        const cls = 'iv-split-mode';
        if (on) document.body.classList.add(cls);
        else document.body.classList.remove(cls);
        const btn = $('iv-btn-split-toggle');
        if (btn) btn.textContent = on ? 'Exit Split' : 'Split View';
    }

    toggleSplitView() {
        this.setSplitView(!document.body.classList.contains('iv-split-mode'));
    }

    setEnabled(enabled) {
        interviewSettingsStorage.update({ enabled: !!enabled });
    }

    _applySettings(settings) {
        this.guard.setThreshold(settings.duplicateThreshold);
        this.pipeline.setDebounceMs(settings.detectionDebounceMs);
        this.pipeline.setMinQuestionLength(settings.minQuestionLength);
        this.pipeline.setEnabled(!!(settings.enabled && settings.autoDetectQuestion));
        const t = $('iv-auto-detect-toggle');
        if (t) t.checked = !!settings.autoDetectQuestion;
    }

    _useLatestTranscript() {
        const text = (this.getLatestTranscript() || '').trim();
        if (!text) {
            this._toast('No transcript available yet — start the translator first.');
            return;
        }
        const input = $('iv-question-input');
        if (input) {
            input.value = text;
            this._refreshQuestionMetadata();
        }
    }

    _clearQuestion() {
        const input = $('iv-question-input');
        if (input) input.value = '';
        this._setText('iv-question-language', '—');
        this._setText('iv-question-vietnamese', '');
        this._setText('iv-generated-prompt', '');
    }

    _refreshQuestionMetadata() {
        const text = ($('iv-question-input')?.value || '').trim();
        const lang = text ? detectLanguage(text) : 'unknown';
        this._setText('iv-question-language', languageLabel(lang));
        // We do NOT call any translation API here — the prompt itself asks
        // ChatGPT to provide the Vietnamese translation, so we just mirror
        // the question when the source is already Vietnamese.
        this._setText(
            'iv-question-vietnamese',
            lang === 'vi' ? text : '(Will be filled in by ChatGPT)',
        );
    }

    _handleAutoDetectedQuestion({ text, language }) {
        if (!text) return;
        if (this.guard.isDuplicate(text)) {
            this._setDetectionStatus('Duplicate suppressed');
            return;
        }
        this.guard.remember(text);
        this._lastDetectedQuestion = { text, language };

        // Push into the input field but never overwrite an in-progress edit.
        const input = $('iv-question-input');
        if (input && (!input.value.trim() || input.dataset.autofilled === '1')) {
            input.value = text;
            input.dataset.autofilled = '1';
            this._refreshQuestionMetadata();
            // Auto-build a prompt for the user to copy.
            this._generatePrompt({ silent: true });
        }

        // Combined Mode auto-call (only when translator is running + setting on).
        const settings = interviewSettingsStorage.get();
        if (settings.combinedMode && settings.combinedAutoCall && this.isTranslatorRunning()) {
            this._lastCombinedQuestion = { text, language };
            this._setText('iv-cb-question', text);
            this.combined.onDetectedQuestion({
                text,
                language: languageLabel(language),
                vietnameseTranslation: language === 'vi' ? text : '',
            });
        }
        this._refreshModePills();
    }

    _setDetectionStatus(status) {
        const el = $('iv-detection-status');
        if (!el) return;
        el.textContent = status;
        el.dataset.status = status.toLowerCase().replace(/\s+/g, '-');
    }

    _generatePrompt({ silent = false } = {}) {
        const settings = interviewSettingsStorage.get();
        const question = ($('iv-question-input')?.value || '').trim();
        if (!question) {
            if (!silent) this._toast('Enter or detect a question first.');
            return;
        }
        const sourceLanguage = detectLanguage(question);
        const prompt = buildInterviewPrompt({
            question,
            sourceLanguage,
            userContext: $('iv-user-context')?.value || '',
            interviewType: $('iv-interview-type')?.value,
            targetLanguage: $('iv-target-language')?.value,
            answerLength: $('iv-answer-length')?.value,
            answerStyle: $('iv-answer-style')?.value,
            languageLevel: $('iv-language-level')?.value,
        });
        const out = $('iv-generated-prompt');
        if (out) out.value = prompt;

        if (settings.savePromptsToHistory) {
            const entry = interviewHistoryService.recordPrompt({
                mode: 'interview',
                originalQuestion: question,
                sourceLanguage: languageLabel(sourceLanguage),
                vietnameseTranslation:
                    sourceLanguage === 'vi' ? question : '',
                generatedPrompt: prompt,
                targetLanguage: $('iv-target-language')?.value,
                interviewType: $('iv-interview-type')?.value,
                languageLevel: $('iv-language-level')?.value,
                answerLength: $('iv-answer-length')?.value,
                answerStyle: $('iv-answer-style')?.value,
            });
            this._currentEntryId = entry.id;
        }

        if (settings.autoCopyGeneratedPrompt) {
            this._copy('iv-generated-prompt', { quiet: true });
        }

        if (!silent) this._toast('Prompt generated.');
    }

    async _copy(elementId, { quiet = false } = {}) {
        const el = $(elementId);
        if (!el || !el.value) {
            if (!quiet) this._toast('Nothing to copy yet.');
            return;
        }
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(el.value);
            } else {
                el.select();
                document.execCommand('copy');
            }
            if (!quiet) this._toast('Copied to clipboard.');
        } catch (e) {
            console.error('[interview] copy failed:', e);
            if (!quiet) this._toast('Copy failed: ' + (e?.message || e));
        }
    }

    _openChatGpt() {
        const url = interviewSettingsStorage.get().chatGptUrl || 'https://chatgpt.com';
        try {
            this.openExternal(url);
        } catch (e) {
            console.error('[interview] open ChatGPT failed:', e);
            window.open(url, '_blank');
        }
        this._toast('Opening ChatGPT in your browser. Sign in with your own account.');
    }

    _saveAnswer() {
        const settings = interviewSettingsStorage.get();
        if (!settings.savePastedAnswersToHistory) {
            this._toast('Saving pasted answers is disabled in settings.');
            return;
        }
        const answer = ($('iv-pasted-answer')?.value || '').trim();
        if (!answer) {
            this._toast('Paste an answer first.');
            return;
        }
        if (this._currentEntryId) {
            interviewHistoryService.attachAnswer(this._currentEntryId, answer);
            this._toast('Answer saved to history.');
        } else {
            // No prompt was generated — record a standalone entry.
            interviewHistoryService.recordPrompt({
                mode: 'interview',
                originalQuestion: $('iv-question-input')?.value || '',
                generatedPrompt: $('iv-generated-prompt')?.value || '',
                chatGptAnswer: answer,
                targetLanguage: $('iv-target-language')?.value,
                interviewType: $('iv-interview-type')?.value,
                languageLevel: $('iv-language-level')?.value,
                answerLength: $('iv-answer-length')?.value,
                answerStyle: $('iv-answer-style')?.value,
            });
            this._toast('Answer saved as new history entry.');
        }
    }

    _clearAnswer() {
        const el = $('iv-pasted-answer');
        if (el) el.value = '';
    }

    _renderHistory() {
        const container = $('iv-history-list');
        if (!container) return;
        const query = ($('iv-history-search')?.value || '').trim();
        const items = query
            ? interviewHistoryService.search(query)
            : interviewHistoryService.list();
        if (!items.length) {
            container.innerHTML = '<div class="iv-history-empty">No interview history yet.</div>';
            return;
        }
        container.innerHTML = items.map((item) => this._renderHistoryItem(item)).join('');
        // Wire per-item actions.
        container.querySelectorAll('[data-iv-history-action]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                const action = e.currentTarget.dataset.ivHistoryAction;
                if (action === 'copy-prompt') this._copyValue(items.find((i) => i.id === id)?.generatedPrompt);
                if (action === 'copy-answer') this._copyValue(items.find((i) => i.id === id)?.chatGptAnswer);
                if (action === 'delete') {
                    interviewHistoryService.remove(id);
                }
                if (action === 'load') this._loadHistoryEntry(items.find((i) => i.id === id));
            });
        });
    }

    _renderHistoryItem(item) {
        const safe = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        return `
        <div class="iv-history-item" data-id="${item.id}">
          <div class="iv-history-meta">
            <span class="iv-history-date">${safe(new Date(item.createdAt).toLocaleString())}</span>
            <span class="iv-history-mode">[${safe(item.mode)}]</span>
            <span class="iv-history-type">${safe(item.interviewType)}</span>
          </div>
          <div class="iv-history-question"><strong>Q:</strong> ${safe(item.originalQuestion)}</div>
          ${item.chatGptAnswer ? `<div class="iv-history-answer"><strong>A:</strong> ${safe(item.chatGptAnswer.slice(0, 280))}${item.chatGptAnswer.length > 280 ? '…' : ''}</div>` : ''}
          <div class="iv-history-actions">
            <button data-iv-history-action="load" data-id="${item.id}" class="iv-mini-btn">Load</button>
            <button data-iv-history-action="copy-prompt" data-id="${item.id}" class="iv-mini-btn">Copy Prompt</button>
            <button data-iv-history-action="copy-answer" data-id="${item.id}" class="iv-mini-btn" ${item.chatGptAnswer ? '' : 'disabled'}>Copy Answer</button>
            <button data-iv-history-action="delete" data-id="${item.id}" class="iv-mini-btn iv-danger">Delete</button>
          </div>
        </div>`;
    }

    _loadHistoryEntry(item) {
        if (!item) return;
        const q = $('iv-question-input');
        if (q) {
            q.value = item.originalQuestion || '';
            delete q.dataset.autofilled;
            this._refreshQuestionMetadata();
        }
        const p = $('iv-generated-prompt');
        if (p) p.value = item.generatedPrompt || '';
        const a = $('iv-pasted-answer');
        if (a) a.value = item.chatGptAnswer || '';
        this._currentEntryId = item.id;
        this._toast('History entry loaded.');
    }

    async _copyValue(value) {
        if (!value) {
            this._toast('Nothing to copy.');
            return;
        }
        try {
            await navigator.clipboard.writeText(value);
            this._toast('Copied to clipboard.');
        } catch (e) {
            console.error(e);
        }
    }

    _clearHistory() {
        if (!confirm('Clear all interview history? This cannot be undone.')) return;
        interviewHistoryService.clear();
    }

    _exportHistory(format) {
        const data = format === 'json'
            ? interviewHistoryService.exportJson()
            : interviewHistoryService.exportText();
        const mime = format === 'json' ? 'application/json' : 'text/plain';
        const ext = format === 'json' ? 'json' : 'txt';
        try {
            const blob = new Blob([data], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `interview-history-${new Date().toISOString().slice(0, 10)}.${ext}`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);
        } catch (e) {
            console.error('[interview] export failed:', e);
            this._toast('Export failed: ' + (e?.message || e));
        }
    }

    _setText(id, value) {
        const el = $(id);
        if (el) el.textContent = value || '';
    }

    _toast(msg) {
        const t = $('iv-toast');
        if (!t) {
            console.log('[interview]', msg);
            return;
        }
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
    }

    // ─── Combined Mode (GPT API) ───────────────────────────────

    refreshGptKeyMask() {
        const el = $('iv-gpt-key-mask');
        if (!el) return;
        const k = (interviewSettingsStorage.get().gptApiKey || '').trim();
        el.textContent = k ? `Configured: ${maskApiKey(k)}` : 'No key configured.';
    }

    refreshTranslatorMode(running) {
        const el = $('iv-mode-translator');
        if (!el) return;
        el.dataset.on = running ? '1' : '0';
        el.innerHTML = `Translator: <b>${running ? 'ON' : 'OFF'}</b>`;
        this._refreshModePills();
    }

    _refreshModePills() {
        const settings = interviewSettingsStorage.get();
        const ivOn = !!settings.enabled;
        const trOn = this.isTranslatorRunning();
        const cbOn = trOn && ivOn && !!settings.combinedMode;
        const ivPill = $('iv-mode-interview');
        if (ivPill) {
            ivPill.dataset.on = ivOn ? '1' : '0';
            ivPill.innerHTML = `Interview: <b>${ivOn ? 'ON' : 'OFF'}</b>`;
        }
        const cbPill = $('iv-mode-combined');
        if (cbPill) {
            cbPill.dataset.on = cbOn ? '1' : '0';
            cbPill.innerHTML = `Combined: <b>${cbOn ? 'ON' : 'OFF'}</b>`;
        }
        // Auto-enable split layout when both Translator and Interview are
        // active. Auto-disable when either turns off (user can still toggle
        // manually with the Split View button).
        const interviewActive = document.getElementById('interview-view')?.classList.contains('active');
        if (cbOn && interviewActive) {
            this.setSplitView(true);
        } else if (!trOn || !ivOn) {
            this.setSplitView(false);
        }
    }

    _setCombinedStatus(state) {
        const el = $('iv-gpt-status');
        if (!el) return;
        el.dataset.state = state;
        const labels = {
            idle: 'idle',
            loading: 'calling GPT…',
            answer: 'answer ready',
            cached: 'served from cache',
            'skipped-short': 'skipped — too short',
            'not-question': 'not an interview question',
            error: 'error',
            aborted: 'aborted',
            'missing-key': 'GPT key missing',
        };
        el.textContent = labels[state] || state;
        if (state !== 'error') {
            const err = $('iv-cb-error');
            if (err) err.style.display = 'none';
        }
    }

    _renderCombinedAnswer(answer) {
        if (!answer) return;
        this._setText('iv-cb-question', answer.question || this._lastCombinedQuestion?.text || '—');
        const box = $('iv-cb-answer');
        if (box) box.textContent = answer.answer || '';
        const err = $('iv-cb-error');
        if (err) err.style.display = 'none';
    }

    _renderCombinedPartial(partial) {
        if (!partial) return;
        if (partial.question) this._setText('iv-cb-question', partial.question);
        const box = $('iv-cb-answer');
        if (box) box.textContent = partial.answer || '';
    }

    _renderCombinedError(err) {
        const el = $('iv-cb-error');
        if (!el) return;
        const code = err?.code || 'error';
        const messages = {
            'missing-key': 'Vui lòng nhập GPT_API_KEY trong Settings để tạo câu trả lời gợi ý.',
            'network': 'Mất mạng — không thể gọi GPT API. Vui lòng kiểm tra kết nối và thử lại.',
            'http': 'Không thể tạo câu trả lời gợi ý. Vui lòng kiểm tra GPT_API_KEY, GPT_BASE_URL hoặc GPT_MODEL.',
            'parse': 'GPT trả về phản hồi không hợp lệ — vui lòng thử lại hoặc đổi model.',
            'invalid': 'GPT phản hồi không đầy đủ. Vui lòng thử lại.',
        };
        el.style.display = '';
        el.textContent = `${messages[code] || 'GPT error'}\n${err?.message ? '— ' + err.message : ''}`.trim();
    }

    async _combinedGenerate({ force = false, style } = {}) {
        const settings = interviewSettingsStorage.get();
        if (!settings.gptApiKey) {
            this._renderCombinedError({ code: 'missing-key' });
            this._setCombinedStatus('missing-key');
            return;
        }
        // Pull the question to answer: prefer Section A's input, fall back to last detection.
        const question =
            ($('iv-question-input')?.value || '').trim()
            || this._lastCombinedQuestion?.text
            || (this.getLatestTranscript() || '').trim();
        if (!question) {
            this._toast('No question to answer yet.');
            return;
        }
        const lang = detectLanguage(question);
        try {
            await this.combined.generate({
                originalTranscript: question,
                vietnameseTranslation: lang === 'vi' ? question : '',
                detectedLanguage: languageLabel(lang),
                style,
                force,
            });
        } catch (e) {
            // already handled by onError listener
        }
    }

    _combinedClear() {
        this._setText('iv-cb-question', '—');
        const box = $('iv-cb-answer');
        if (box) box.textContent = '';
        const err = $('iv-cb-error');
        if (err) err.style.display = 'none';
        this._setCombinedStatus('idle');
        this.combined.clearCache();
        this._lastAutoDetectedFingerprint = null;
    }
}
