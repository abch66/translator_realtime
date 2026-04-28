/**
 * interviewHistoryService — thin façade over interviewHistoryStorage that
 * exposes the operations the UI cares about (record-on-prompt, attach
 * answer, search/export). Centralising it here means the UI never talks
 * directly to localStorage.
 */

import { interviewHistoryStorage } from '../../storage/interviewHistoryStorage.js';

export const interviewHistoryService = {
    list() {
        return interviewHistoryStorage.list();
    },

    search(query) {
        return interviewHistoryStorage.search(query);
    },

    recordPrompt(payload) {
        return interviewHistoryStorage.add(payload);
    },

    attachAnswer(id, answer) {
        return interviewHistoryStorage.update(id, { chatGptAnswer: answer || '' });
    },

    updateNotes(id, notes) {
        return interviewHistoryStorage.update(id, { notes: notes || '' });
    },

    remove(id) {
        interviewHistoryStorage.remove(id);
    },

    clear() {
        interviewHistoryStorage.clear();
    },

    onChange(cb) {
        return interviewHistoryStorage.onChange(cb);
    },

    exportJson() {
        return interviewHistoryStorage.exportJson();
    },

    exportText() {
        return interviewHistoryStorage.exportText();
    },
};
