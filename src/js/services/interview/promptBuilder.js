/**
 * promptBuilder — produces the ChatGPT Account Manual Mode prompt
 * described in the project spec.
 *
 * The prompt template is intentionally fixed and embeds an explicit
 * ethics/anti-cheating clause so users cannot accidentally generate a
 * prompt that asks ChatGPT to help them deceive an interviewer.
 *
 * Output policy (per the latest spec): ChatGPT must reply with ONLY the
 * suggested answer text in the target language — no analysis, no
 * "context summary", no question-explanation, no Vietnamese meaning
 * (unless the target language IS Vietnamese), no useful-phrases block,
 * no markdown headings, no labels (`A.`, `B.`, `Suggested answer:`,
 * etc.). One single answer, ready to be spoken.
 */

import { detectLanguage, languageLabel } from '../../utils/languageUtils.js';

const SYSTEM_BLOCK = [
    'You are an interview preparation assistant. Your job is to help the user',
    'understand interview questions and prepare natural, honest, ethical, and',
    'appropriate answers. Do not help with deception, impersonation, cheating,',
    'hiding AI use, bypassing interview rules, or manipulating any assessment',
    'system. The answer should be realistic, concise, easy to speak, and',
    'suitable for interview practice.',
].join(' ');

/**
 * Build a complete ChatGPT prompt for the given interview context.
 *
 * @param {object} input
 * @param {string} input.question - Original question text.
 * @param {string} [input.sourceLanguage] - Detected/forced source language code.
 * @param {string} [input.vietnameseTranslation] - Optional pre-computed VN translation.
 * @param {string} [input.userContext] - Free-form background about the user.
 * @param {string} [input.interviewType] - e.g. "Job interview", "Visa interview".
 * @param {string} [input.targetLanguage] - "Vietnamese" | "English" | "German".
 * @param {string} [input.answerLength] - "Short" | "Medium" | "Detailed".
 * @param {string} [input.answerStyle] - "Natural" | "Professional" | "Confident" | "Humble".
 * @param {string} [input.languageLevel] - "Simple" | "A2" | "B1" | "B2" | "Professional".
 * @returns {string} Full prompt ready to be copied into ChatGPT.
 */
export function buildInterviewPrompt(input) {
    const safe = (v, fallback = '') => (v == null ? fallback : String(v).trim());

    const question = safe(input.question);
    const sourceCode = safe(input.sourceLanguage) || detectLanguage(question);
    const sourceLanguage = languageLabel(sourceCode);

    const vietnameseTranslation = safe(input.vietnameseTranslation, '(none)');
    const userContext = safe(input.userContext, '(none)');
    const interviewType = safe(input.interviewType, 'General interview');
    const targetLanguage = safe(input.targetLanguage, 'German');
    const answerLength = safe(input.answerLength, 'Medium');
    const answerStyle = safe(input.answerStyle, 'Natural');
    const languageLevel = safe(input.languageLevel, 'B1');

    return [
        'SYSTEM / ROLE:',
        '',
        SYSTEM_BLOCK,
        '',
        'USER PROMPT:',
        '',
        'Interview question:',
        question || '(empty)',
        '',
        'Detected source language:',
        sourceLanguage,
        '',
        'Vietnamese translation of the question:',
        vietnameseTranslation,
        '',
        'User background/context:',
        userContext,
        '',
        'Interview type:',
        interviewType,
        '',
        'Target answer language:',
        targetLanguage,
        '',
        'Answer length:',
        answerLength,
        '',
        'Answer style:',
        answerStyle,
        '',
        'Language level:',
        languageLevel,
        '',
        'Task:',
        'Reply with ONLY the suggested answer text in the target answer',
        'language above, at the requested language level. Do NOT include any',
        'analysis, context summary, question explanation, Vietnamese meaning,',
        '"useful phrases" block, alternative versions, markdown headings, or',
        'section labels (no "A.", "Suggested answer:", "Antwort:", etc.).',
        'Just the answer, ready to speak. Keep it natural, honest, and easy',
        'to pronounce. Do not invent fake experience.',
    ].join('\n');
}
