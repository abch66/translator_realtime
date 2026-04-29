/**
 * End-to-end smoke test for the Interview Assistant + Combined Mode pipeline,
 * using a mocked localStorage + fetch so we can run it under plain Node.
 *
 * Verifies:
 *   - Settings storage round-trip (incl. partial ivContext merge)
 *   - History storage CRUD
 *   - Question detection pipeline (debounced)
 *   - CombinedAnswerService end-to-end:
 *       * builds plain-text user prompt
 *       * issues fetch with proper auth + body
 *       * returns a single concise `answer` (no short_answer)
 *       * caches identical questions (no second fetch)
 *       * regenerate forces a fresh call with style hint
 *       * cancels in-flight request when a fresher question arrives
 *       * skips when transcript is too short
 *   - Streaming path (SSE chunks → live partial deltas → final answer)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

// Mock localStorage
const _store = new Map();
globalThis.localStorage = {
    getItem: (k) => (_store.has(k) ? _store.get(k) : null),
    setItem: (k, v) => _store.set(k, String(v)),
    removeItem: (k) => _store.delete(k),
    clear: () => _store.clear(),
};

let _fetchCallCount = 0;
let _lastFetchUrl = null;
let _lastFetchAuth = null;
let _lastFetchBody = null;

function jsonResponse(content) {
    return {
        ok: true,
        status: 200,
        async json() { return { choices: [{ message: { content } }] }; },
        async text() { return JSON.stringify({ choices: [{ message: { content } }] }); },
    };
}

globalThis.fetch = async (url, opts) => {
    _fetchCallCount++;
    _lastFetchUrl = url;
    _lastFetchAuth = opts?.headers?.['Authorization'];
    _lastFetchBody = opts?.body ? JSON.parse(opts.body) : null;
    return jsonResponse(
        'Ich möchte diese Ausbildung machen, weil ich Technik und Maschinen mag. ' +
        'Ich arbeite gern praktisch und lerne schnell. ' +
        'Außerdem finde ich es spannend, wie Maschinen funktionieren.',
    );
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const importFrom = (rel) => import('file://' + path.resolve(root, rel));

const { interviewSettingsStorage } = await importFrom('src/js/storage/interviewSettingsStorage.js');
const { interviewHistoryStorage } = await importFrom('src/js/storage/interviewHistoryStorage.js');
const { QuestionDetectionPipeline } = await importFrom('src/js/services/interview/questionDetector.js');
const { CombinedAnswerService } = await importFrom('src/js/services/interview/combinedAnswerService.js');
const { buildInterviewPrompt } = await importFrom('src/js/services/interview/promptBuilder.js');
const { chatCompletionStream } = await importFrom('src/js/services/interview/gptClient.js');

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
ok('default combinedStreaming on', s0.combinedStreaming === true);
ok('default detectionDebounceMs in 800-1200 range',
    s0.detectionDebounceMs >= 800 && s0.detectionDebounceMs <= 1200);
ok('default gptMaxTokens', s0.gptMaxTokens === 320);

interviewSettingsStorage.update({
    gptApiKey: 'sk-test-1234567890',
    combinedStreaming: false, // tests below use non-streaming mock fetch
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

console.log('# CombinedAnswerService — non-streaming path');
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
ok('combined returned answer object', !!r1 && typeof r1.answer === 'string');
ok('answer is non-empty', r1.answer.length > 20);
ok('answer NOT split into short/full fields',
    r1.short_answer === undefined && r1.full_answer === undefined);
ok('answer has roughly 3-6 sentences',
    (r1.answer.match(/[.!?]+/g) || []).length >= 2);
ok('called real chat-completions URL',
    _lastFetchUrl === 'https://api.openai.com/v1/chat/completions',
    _lastFetchUrl);
ok('called with Bearer token', /^Bearer sk-test/.test(_lastFetchAuth || ''));
ok('used correct model in body', _lastFetchBody?.model === 'gpt-4o-mini');
ok('used max_tokens cap', typeof _lastFetchBody?.max_tokens === 'number'
    && _lastFetchBody.max_tokens >= 300);
ok('non-streaming uses no stream flag', !_lastFetchBody?.stream);
ok('1 fetch call so far', _fetchCallCount === 1);

const r2 = await cb.generate({
    originalTranscript: 'Warum möchten Sie diese Ausbildung machen?',
    detectedLanguage: 'German',
});
ok('cached call did not hit the network', _fetchCallCount === 1, `fetchCount=${_fetchCallCount}`);
ok('cached answer matches first', r2.answer === r1.answer);

const r3 = await cb.regenerate({
    originalTranscript: 'Warum möchten Sie diese Ausbildung machen?',
    detectedLanguage: 'German',
    style: 'simpler',
});
ok('regenerate forces a fresh call', _fetchCallCount === 2);
ok('regenerate body has simpler style hint',
    _lastFetchBody?.messages?.some((m) => /simplest possible language/.test(m.content || '')));

const r4 = await cb.generate({ originalTranscript: 'short' }); // 1 word, < gptMinWords
ok('short transcript skipped', r4 === null);

console.log('# Cancel in-flight request when a fresher question arrives');
{
    let abortedSeen = false;
    let resolveSlow;
    globalThis.fetch = async (url, opts) => {
        const sig = opts?.signal;
        return await new Promise((resolve, reject) => {
            resolveSlow = () => resolve(jsonResponse('Slow answer text answer text answer text.'));
            if (sig) {
                sig.addEventListener('abort', () => {
                    abortedSeen = true;
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            }
        });
    };
    const cb3 = new CombinedAnswerService({
        getSettings: () => interviewSettingsStorage.get(),
        onStatus: () => {}, onAnswer: () => {}, onError: () => {},
    });
    const p1 = cb3.generate({ originalTranscript: 'Tell me about your strengths and weaknesses please.' });
    // While p1 is hanging, fire a second one — it should abort p1.
    const p2 = cb3.generate({ originalTranscript: 'What are your career goals for the next five years?' });
    // Resolve the (now cancelled) first request and then the second.
    setTimeout(() => resolveSlow && resolveSlow(), 30);
    const [a1, a2] = await Promise.all([p1, p2]);
    ok('first request was aborted', abortedSeen);
    ok('first request returned null', a1 === null);
    ok('second request returned an answer', !!a2 && typeof a2.answer === 'string');
}

console.log('# Context-aware Combined Mode prompt');
{
    // Re-arm a JSON fetch stub like the non-streaming path.
    _fetchCallCount = 0;
    _lastFetchUrl = null; _lastFetchAuth = null; _lastFetchBody = null;
    globalThis.fetch = async (url, opts) => {
        _fetchCallCount++;
        _lastFetchUrl = url;
        _lastFetchAuth = opts?.headers?.Authorization || opts?.headers?.authorization;
        try { _lastFetchBody = JSON.parse(opts.body); } catch { _lastFetchBody = null; }
        return jsonResponse('A. Tóm tắt: ...\nB. Câu hỏi: ...\nC. ...\nD. ...\nE. ...\nF. ...');
    };
    const cbCtx = new CombinedAnswerService({
        getSettings: () => ({
            ...interviewSettingsStorage.get(),
            gptApiKey: 'sk-test-ctx',
            useTranslatorContext: true,
        }),
        onStatus: () => {}, onAnswer: () => {}, onError: () => {},
    });
    const ctx = {
        sourceLanguage: 'de',
        targetLanguage: 'vi',
        fullTranscript: 'Hallo, schön Sie zu sehen. Erzählen Sie etwas über sich.',
        fullVietnameseTranslation: 'Xin chào, rất vui được gặp bạn. Hãy giới thiệu về bạn.',
        latestTranscriptSegment: 'Erzählen Sie etwas über sich.',
        latestVietnameseSegment: 'Hãy giới thiệu về bạn.',
        recentSegments: [
            { text: 'Hallo, schön Sie zu sehen.', translation: 'Xin chào, rất vui được gặp bạn.', language: 'de' },
            { text: 'Erzählen Sie etwas über sich.', translation: 'Hãy giới thiệu về bạn.', language: 'de' },
        ],
        detectedQuestion: { text: 'Erzählen Sie etwas über sich?', language: 'de' },
        timestamps: {}, isListening: true, lastUpdatedAt: Date.now(),
    };
    const ans = await cbCtx.generate({
        translatorContext: ctx,
        originalTranscript: 'Erzählen Sie etwas über sich?',
        detectedLanguage: 'German',
        userContext: 'Học sinh Ausbildung',
        interviewType: 'Ausbildungsbewerbung',
        targetLanguage: 'Deutsch',
        answerLength: 'Medium',
        answerStyle: 'Natural',
        languageLevel: 'A2-B1',
    });
    ok('context call returned answer', !!ans && typeof ans.answer === 'string');
    ok('context call recorded promptMode=context', ans.promptMode === 'context');
    const userMsg = _lastFetchBody?.messages?.find((m) => m.role === 'user')?.content || '';
    ok('user prompt has Full transcript section', /Full transcript so far:/.test(userMsg));
    ok('user prompt has Recent transcript segments section', /Recent transcript segments:/.test(userMsg));
    ok('user prompt has Detected question line', /Detected question, if any:/.test(userMsg));
    ok('user prompt has Output format A-F', /A\.\s*Context summary[\s\S]*F\.\s*Useful phrases/.test(userMsg));
    ok('user prompt embeds full transcript text', userMsg.includes('Erzählen Sie etwas über sich.'));
    ok('user prompt embeds Vietnamese translation', userMsg.includes('Hãy giới thiệu về bạn'));
    ok('user prompt embeds source language', /Source language:\s*\nde/.test(userMsg));
    const sysMsg = _lastFetchBody?.messages?.find((m) => m.role === 'system')?.content || '';
    ok('system prompt has anti-cheating clause', /Do not invent fake experience/.test(sysMsg));
    ok('system prompt mentions full context', /full context/i.test(sysMsg));
}

console.log('# Combined Mode legacy path (no translatorContext)');
{
    _fetchCallCount = 0;
    _lastFetchBody = null;
    globalThis.fetch = async (url, opts) => {
        _fetchCallCount++;
        try { _lastFetchBody = JSON.parse(opts.body); } catch { _lastFetchBody = null; }
        return jsonResponse('Bare answer.');
    };
    const cbLegacy = new CombinedAnswerService({
        getSettings: () => ({
            ...interviewSettingsStorage.get(),
            gptApiKey: 'sk-test-legacy',
            useTranslatorContext: false,
        }),
        onStatus: () => {}, onAnswer: () => {}, onError: () => {},
    });
    const ans = await cbLegacy.generate({
        originalTranscript: 'Why do you want this job and what makes you qualified?',
        detectedLanguage: 'English',
    });
    ok('legacy call returned answer', !!ans && ans.promptMode === 'legacy');
    const userMsg = _lastFetchBody?.messages?.find((m) => m.role === 'user')?.content || '';
    ok('legacy prompt does NOT include Full transcript section',
        !/Full transcript so far:/.test(userMsg));
    ok('legacy prompt has bare Question: line',
        /Question: Why do you want this job/.test(userMsg));
}

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

console.log('# Streaming SSE path');
{
    // Build a fake SSE response: emit two chunks, then [DONE].
    const events = [
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Ich' } }] }) + '\n\n',
        'data: ' + JSON.stringify({ choices: [{ delta: { content: ' interessiere mich.' } }] }) + '\n\n',
        'data: [DONE]\n\n',
    ];
    const body = Readable.from(events.map((e) => Buffer.from(e)));
    body.getReader = function getReader() {
        const it = this[Symbol.asyncIterator]();
        return {
            async read() {
                const r = await it.next();
                if (r.done) return { value: undefined, done: true };
                return { value: r.value, done: false };
            },
            releaseLock() {},
        };
    };
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        body,
        async text() { return events.join(''); },
    });
    const partials = [];
    const result = await chatCompletionStream({
        baseUrl: 'https://api.test/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
        onDelta: (d, full) => partials.push(full),
    });
    ok('streaming aggregated full content', result === 'Ich interessiere mich.');
    ok('onDelta fired at least once with a partial',
        partials.length >= 1 && partials[partials.length - 1] === 'Ich interessiere mich.');
}

console.log('# Prompt builder placeholders');
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
