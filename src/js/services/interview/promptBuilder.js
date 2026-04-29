/**
 * promptBuilder — produces the ChatGPT Account Manual Mode prompt
 * described in the project spec.
 *
 * The prompt template is intentionally fixed and embeds an explicit
 * ethics/anti-cheating clause so users cannot accidentally generate a
 * prompt that asks ChatGPT to help them deceive an interviewer.
 */

import { detectLanguage, languageLabel } from '../../utils/languageUtils.js';

const SYSTEM_BLOCK = `You are an interview preparation assistant. Your job is to help the user understand interview questions and prepare natural, honest, ethical, and appropriate answers. Do not help with deception, impersonation, cheating, hiding AI use, bypassing interview rules, or manipulating any assessment system. The answer should be realistic, concise, easy to speak, and suitable for interview practice.`;

const OUTPUT_FORMAT = `OUTPUT FORMAT:

A. Meaning of the question in Vietnamese:
...

B. What the interviewer wants to know:
...

C. Suggested answer:
...

D. Vietnamese meaning:
...

E. Shorter version:
...

F. Useful phrases:
...`;

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

    const vietnameseTranslation = safe(
        input.vietnameseTranslation,
        '(Translation will be produced by ChatGPT.)',
    );
    const userContext = safe(input.userContext, '(Not provided.)');
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
        'Interview question original language:',
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
        'Please do the following:',
        '',
        '1. Explain the meaning of the interview question in Vietnamese.',
        '2. Identify what the interviewer wants to know.',
        '3. Suggest a natural answer in the target answer language.',
        '4. Make the answer suitable for the selected language level.',
        '5. Keep the answer honest, realistic, and easy to speak.',
        '6. If the target language is not Vietnamese, also provide the Vietnamese meaning of the suggested answer.',
        '7. Give 2 alternative shorter versions if possible.',
        '8. Add useful vocabulary or phrases for this answer if the target language is English or German.',
        '',
        OUTPUT_FORMAT,
    ].join('\n');
}
