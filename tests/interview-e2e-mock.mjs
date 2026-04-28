#!/usr/bin/env node
/**
 * End-to-end mock test.
 * Mocks localStorage + fetch and exercises the full interview pipeline:
 *   - settings storage round-trip
 *   - history storage CRUD
 *   - question detection pipeline
 *   - duplicate guard
 *   - prompt builder
 *   - combined answer service with mocked HTTP
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mock browser globals used by storage modules.
const _ls = new Map();
globalThis.localStorage = {
    getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
    setItem: (k, v) => _ls.set(k, String(v)),
    removeItem: (k) => _ls.delete(k),
    clear: () => _ls.clear(),
    key: (i) => Array.from(_ls.keys())[i] || null,
    get length() { return _ls.size; },
};

// Mock fetch — returns a fake OpenAI response.
let _fetchCallCount = 0;
let _lastFetchUrl = null;
let _lastFetchAuth = null;
let _lastFetchBody = null;
globalThis.fetch = async (url, opts) => {
    _fetchCallCount++;
    _lastFetchUrl = url;
    _lastFetchAuth = opts?.headers?.['Authorization'];
    _lastFetchBody = opts?.body ? JSON.parse(opts.body) : null;
    const json = {
        is_interview_question: true,
        detected_question: 'Warum möchten Sie diese Ausbildung machen?',
        question_vi: 'Tại sao bạn muốn học nghề này?',
        short_answer: 'Ich interessiere mich für Technik und Maschinen.',
        full_answer: 'Ich möchte diese Ausbildung machen, weil ich Technik und Maschinen liebe.',
        answer_vi: 'Tôi muốn học nghề này vì tôi thích máy móc và kỹ thuật.',
        important_vocabulary: [
            { word: 'Ausbildung', meaning_vi: 'đào tạo nghề' },
            { word: 'Maschinen', meaning_vi: 'máy móc' },
        ],
        confidence: 0.92,
    };
    return {
        ok: true,
        status: 200,
        async json() {
            return {
                choices: [{ message: { content: JSON.stringify(json) } }],
            };
        },
        async text() { return JSON.stringify({ choices: [{ message: { content: JSON.stringify(json) } }] }); },
    };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const importFrom = (rel) => import('file://' + path.resolve(root, rel));

const { interviewSettingsStorage } = await importFrom('src/js/storage/interviewSettingsStorage.js');
const { interviewHistoryStorage } = await importFrom('src/js/storage/interviewHistoryStorage.js');
const { QuestionDetectionPipeline } = await importFrom('src/js/services/interview/questionDetector.js');
const { CombinedAnswerService } = await importFrom('src/js/services/interview/combinedAnswerService.js');
const { buildInterviewPrompt } = await importFrom('src/js/services/interview/promptBuilder.js');

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
    if (cond) { pass++; console.log('  ok  -', label); }
    else      { fail++; console.error('  FAIL -', label, extra ?? ''); }
};

console.log('# Settings storage round-trip');
const s0 = interviewSettingsStorage.get();
ok('default ivContext.beruf', s0.ivContext.beruf === 'Maschinen- und Anlagenführer');
ok('default ivContext.languageLevel', s0.ivContext.languageLevel === 'A2-B1');
ok('default gptBaseUrl', s0.gptBaseUrl === 'https://api.openai.com/v1');
ok('default gptModel', s0.gptModel === 'gpt-4o-mini');
ok('default combinedAutoCall', s0.combinedAutoCall === true);

interviewSettingsStorage.update({
    gptApiKey: 'sk-test-1234567890',
    ivContext: { beruf: 'Mechatroniker' },
});
const s1 = interviewSettingsStorage.get();
ok('persisted gptApiKey', s1.gptApiKey === 'sk-test-1234567890');
ok('partial ivContext merge keeps companyName', s1.ivContext.companyName === 'Teledoor');
ok('partial ivContext merge updates beruf', s1.ivContext.beruf === 'Mechatroniker');

console.log('# History storage CRUD');
interviewHistoryStorage.clear();
const item = {
    mode: 'interview-assistant',
    originalQuestion: 'Tell me about yourself',
    detectedLanguage: 'en',
    vietnameseTranslation: '',
    generatedPrompt: 'PROMPT...',
    chatGptAnswer: '',
    targetLanguage: 'English',
    interviewType: 'Job interview',
    languageLevel: 'B1',
};
const saved = interviewHistoryStorage.add(item);
ok('history item gets id', !!saved.id);
ok('history item gets timestamp', !!saved.createdAt);
ok('list returns 1 item', interviewHistoryStorage.list().length === 1);
const updated = interviewHistoryStorage.update(saved.id, { chatGptAnswer: 'My answer.' });
ok('update merged', updated.chatGptAnswer === 'My answer.');
interviewHistoryStorage.remove(saved.id);
ok('remove worked', interviewHistoryStorage.list().length === 0);

console.log('# Question detection pipeline (debounced)');
await new Promise(async (resolve) => {
    const detected = [];
    const pipeline = new QuestionDetectionPipeline({
        debounceMs: 50,
        minQuestionLength: 10,
        onQuestion: (q) => detected.push(q),
        onStatusChange: () => {},
    });
    pipeline.setEnabled(true);
    pipeline.pushTranscript('Hi there.');
    pipeline.pushTranscript('Hi there. Tell me about your background?');
    setTimeout(() => {
        ok('pipeline detected at least 1 question', detected.length >= 1);
        ok('detected question contains "background"',
            detected.some((d) => /background/i.test(d.text)));
        resolve();
    }, 200);
});

console.log('# CombinedAnswerService with mocked fetch');
_fetchCallCount = 0;
const cb = new CombinedAnswerService({
    getSettings: () => interviewSettingsStorage.get(),
    onStatus: () => {},
    onAnswer: () => {},
    onError: (e) => console.error('   onError:', e?.code, e?.message),
});
const r1 = await cb.generate({
    originalTranscript: 'Warum möchten Sie diese Ausbildung machen?',
    detectedLanguage: 'German',
});
ok('combined returned answer object', r1 && r1.is_interview_question === true);
ok('answer has short_answer', r1.short_answer.includes('Technik'));
ok('answer has vocab', r1.important_vocabulary.length === 2);
ok('confidence parsed', r1.confidence === 0.92);
ok('called real chat-completions URL',
    _lastFetchUrl === 'https://api.openai.com/v1/chat/completions',
    _lastFetchUrl);
ok('called with Bearer token', /^Bearer sk-test/.test(_lastFetchAuth || ''));
ok('used correct model in body', _lastFetchBody?.model === 'gpt-4o-mini');
ok('requested JSON response_format', _lastFetchBody?.response_format?.type === 'json_object');
ok('1 fetch call so far', _fetchCallCount === 1);

const r2 = await cb.generate({
    originalTranscript: 'Warum möchten Sie diese Ausbildung machen?',
    detectedLanguage: 'German',
});
ok('cached call did not hit the network', _fetchCallCount === 1, `fetchCount=${_fetchCallCount}`);
ok('cached answer returned', r2.short_answer === r1.short_answer);

const r3 = await cb.regenerate({
    originalTranscript: 'Warum möchten Sie diese Ausbildung machen?',
    detectedLanguage: 'German',
    style: 'shorter',
});
ok('regenerate forces a fresh call', _fetchCallCount === 2);
ok('regenerate body has shorter style hint',
    _lastFetchBody?.messages?.some((m) => /Style hint: shorter/.test(m.content || '')));

const r4 = await cb.generate({ originalTranscript: 'short' }); // 1 word, < gptMinWords
ok('short transcript skipped', r4 === null);

console.log('# Missing key error path');
interviewSettingsStorage.update({ gptApiKey: '' });
const cb2 = new CombinedAnswerService({
    getSettings: () => interviewSettingsStorage.get(),
    onStatus: () => {},
    onAnswer: () => {},
    onError: () => {},
});
let missing;
try { await cb2.generate({ originalTranscript: 'Why do you want this job?' }); } catch (e) { missing = e; }
ok('missing-key throws GptClientError', missing?.code === 'missing-key');

console.log('# Transport-level fallback when provider returns non-JSON body');
const { chatCompletionJson } = await importFrom('src/js/services/interview/gptClient.js');
{
    let calls = 0;
    let firstSentResponseFormat = null;
    let secondSentResponseFormat = null;
    globalThis.fetch = async (url, opts) => {
        calls++;
        const body = opts?.body ? JSON.parse(opts.body) : null;
        if (calls === 1) {
            firstSentResponseFormat = body?.response_format;
            return {
                ok: true,
                status: 200,
                async text() { return 'I am not JSON, sorry.'; },
            };
        }
        secondSentResponseFormat = body?.response_format;
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({
                    choices: [{ message: { content: '{"is_interview_question":false,"reason":"test","confidence":0.1}' } }],
                });
            },
        };
    };

    const out = await chatCompletionJson({
        baseUrl: 'https://api.test/v1',
        apiKey: 'sk-test',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
    });
    ok('1st call had response_format=json_object',
        firstSentResponseFormat?.type === 'json_object');
    ok('2nd call dropped response_format', secondSentResponseFormat === undefined);
    ok('fallback succeeded', out.json.is_interview_question === false);
    ok('exactly 2 fetch calls', calls === 2);
}

console.log('# Both attempts fail -> diagnostic message includes body snippet');
{
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        async text() { return '<html><body>Cloudflare error</body></html>'; },
    });
    let err;
    try {
        await chatCompletionJson({
            baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
        });
    } catch (e) { err = e; }
    ok('throws GptClientError', err?.code === 'parse' || err?.code === 'invalid');
}

console.log('# Prompt builder placeholders');
const settings = interviewSettingsStorage.get();
const prompt = buildInterviewPrompt({
    question: 'Why do you want this job?',
    userContext: '5y experience in DevOps',
    interviewType: 'Job interview',
    targetLanguage: 'English',
    answerLength: 'Medium',
    answerStyle: 'Confident',
    languageLevel: 'B2',
});
ok('prompt embeds question', prompt.includes('Why do you want this job?'));
ok('prompt embeds userContext', prompt.includes('DevOps'));
ok('prompt has anti-cheat clause', prompt.includes('Do not help with deception'));
ok('prompt has output sections A-F',
    /A\..+?B\..+?C\..+?D\..+?E\..+?F\./s.test(prompt));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
