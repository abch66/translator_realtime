#!/usr/bin/env node
/**
 * Pure-Node smoke tests for the Interview Assistant logic modules.
 * Run with `node scripts/interview-smoke-test.mjs` from the repo root.
 *
 * These cover the non-DOM side of the new code — anything that touches
 * `document` lives in InterviewAssistantPanel.js and needs the real Tauri
 * webview to test.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const importFrom = (rel) => import('file://' + path.resolve(repoRoot, rel));

const { diceSimilarity, normalizeText, isSimilar } = await importFrom('src/js/utils/textSimilarity.js');
const { fnv1aHash, fingerprint } = await importFrom('src/js/utils/hashUtils.js');
const { detectLanguage, languageLabel, QUESTION_CUES } = await importFrom('src/js/utils/languageUtils.js');
const { findQuestions, detectLatestQuestion } = await importFrom('src/js/services/interview/questionDetector.js');
const { DuplicateQuestionGuard } = await importFrom('src/js/services/interview/duplicateQuestionGuard.js');
const { buildInterviewPrompt } = await importFrom('src/js/services/interview/promptBuilder.js');
const { parseJsonFromCompletion, GptClientError } = await importFrom('src/js/services/interview/gptClient.js');
const { CombinedAnswerService } = await importFrom('src/js/services/interview/combinedAnswerService.js');
const { maskApiKey } = await importFrom('src/js/utils/secretUtils.js');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
    if (cond) { pass++; console.log('  ok -', label); }
    else { fail++; console.error('  FAIL -', label, extra ?? ''); }
}

console.log('# textSimilarity');
ok('normalize strips accents', normalizeText('Tại sao bạn?') === 'tai sao ban');
ok('identical strings sim=1', diceSimilarity('hello world', 'hello world') === 1);
ok('different strings sim<0.4', diceSimilarity('hello world', 'goodbye moon') < 0.4);
ok('isSimilar near-duplicates', isSimilar('Tell me about your strengths', 'Tell me about your strength.', 0.8));

console.log('# hashUtils');
ok('hash stable', fnv1aHash('foo') === fnv1aHash('foo'));
ok('hash differs across inputs', fnv1aHash('foo') !== fnv1aHash('bar'));
ok('fingerprint stable', fingerprint('hello world') === fingerprint('hello world'));

console.log('# languageUtils');
ok('detect VI by diacritics', detectLanguage('Vì sao bạn muốn làm việc ở đây?') === 'vi');
ok('detect DE by umlaut', detectLanguage('Können Sie sich vorstellen?') === 'de');
ok('detect EN', detectLanguage('Tell me about your experience') === 'en');
ok('label EN', languageLabel('en') === 'English');
ok('cues lists exist', QUESTION_CUES.en.length > 5 && QUESTION_CUES.de.length > 5 && QUESTION_CUES.vi.length > 5);

console.log('# questionDetector');
ok('detects "tell me about" without ?', findQuestions('Hello there. Tell me about your experience as a developer.').length === 1);
ok('detects ?-suffix question', findQuestions('I have 5y. What is your biggest weakness?').some((q) => q.text.includes('weakness')));
ok('rejects too-short', findQuestions('Hi.').length === 0);
const de = findQuestions('Warum möchten Sie hier arbeiten? Wo wohnen Sie?');
ok('multiple DE questions', de.length === 2 && de[0].language === 'de');
ok('detectLatestQuestion picks last',
    detectLatestQuestion('Warum möchten Sie hier arbeiten? Wo wohnen Sie?').text.toLowerCase().includes('wohnen'));

console.log('# duplicateQuestionGuard');
const guard = new DuplicateQuestionGuard({ threshold: 0.85 });
ok('first not duplicate', !guard.isDuplicate('Tell me about your strengths.'));
guard.remember('Tell me about your strengths.');
ok('exact duplicate caught', guard.isDuplicate('Tell me about your strengths.'));
ok('near duplicate caught', guard.isDuplicate('tell me about your strength'));
ok('different not duplicate', !guard.isDuplicate('What is your biggest weakness?'));

console.log('# promptBuilder');
const prompt = buildInterviewPrompt({
    question: 'Tell me about yourself',
    userContext: '5y experience, software engineer',
    interviewType: 'Job interview',
    targetLanguage: 'English',
    answerLength: 'Medium',
    answerStyle: 'Professional',
    languageLevel: 'B2',
});
ok('prompt contains SYSTEM', prompt.includes('SYSTEM / ROLE'));
ok('prompt contains question', prompt.includes('Tell me about yourself'));
ok('prompt contains output format', prompt.includes('OUTPUT FORMAT'));
ok('prompt contains anti-cheat clause', prompt.includes('Do not help with deception'));

console.log('# secretUtils');
ok('mask short key', maskApiKey('sk-1234') === '****');
ok('mask long key shows head/tail', maskApiKey('sk-abcdefghij1234') === 'sk-****1234');
ok('empty -> empty', maskApiKey('') === '' && maskApiKey(null) === '');

console.log('# gptClient.parseJsonFromCompletion');
ok('parses plain JSON', parseJsonFromCompletion('{"a":1}').a === 1);
ok('strips ```json fence',
    parseJsonFromCompletion('```json\n{"a":2}\n```').a === 2);
ok('snips surrounding prose',
    parseJsonFromCompletion('Here is the answer: {"a":3}\nThanks!').a === 3);
let parseThrew = false;
try { parseJsonFromCompletion('not json at all'); } catch (e) { parseThrew = e instanceof GptClientError && e.code === 'parse'; }
ok('throws GptClientError on garbage', parseThrew);

console.log('# combinedAnswerService');
const cb = new CombinedAnswerService({
    getSettings: () => ({
        gptApiKey: '',
        gptBaseUrl: 'https://api.openai.com/v1',
        gptModel: 'gpt-4o-mini',
        gptMinWords: 5,
        combinedMode: true,
        combinedAutoCall: true,
        duplicateThreshold: 0.85,
        ivContext: { targetLanguage: 'Deutsch', languageLevel: 'A2-B1' },
    }),
});
let missingKeyErr = null;
try {
    await cb.generate({ originalTranscript: 'Warum möchten Sie diese Ausbildung machen?' });
} catch (e) { missingKeyErr = e; }
ok('missing-key error code', missingKeyErr?.code === 'missing-key');
ok('combined service has cache primitives',
    typeof cb.regenerate === 'function' && typeof cb.clearCache === 'function');

console.log('# translatorContextStore');
const { translatorContextStore } = await import('../src/js/storage/translatorContextStore.js');
translatorContextStore.reset();
ok('empty store has no context', translatorContextStore.hasContext() === false);
translatorContextStore.setSourceLanguage('de');
translatorContextStore.setTargetLanguage('vi');
translatorContextStore.pushOriginal('Hallo, wie geht es dir?', 'de');
translatorContextStore.pushTranslation('Xin chào, bạn khỏe không?');
translatorContextStore.pushOriginal('Erzählen Sie etwas über sich.', 'de');
translatorContextStore.pushTranslation('Hãy giới thiệu về bản thân bạn.');
translatorContextStore.setDetectedQuestion('Erzählen Sie etwas über sich?', 'de');
const snap = translatorContextStore.get();
ok('store tracks sourceLanguage', snap.sourceLanguage === 'de');
ok('store tracks targetLanguage', snap.targetLanguage === 'vi');
ok('store concatenates fullTranscript',
    snap.fullTranscript.includes('Hallo') && snap.fullTranscript.includes('Erzählen Sie'));
ok('store concatenates fullVietnameseTranslation',
    snap.fullVietnameseTranslation.includes('Xin chào')
    && snap.fullVietnameseTranslation.includes('giới thiệu'));
ok('store exposes latestTranscriptSegment',
    snap.latestTranscriptSegment === 'Erzählen Sie etwas über sich.');
ok('store exposes latestVietnameseSegment',
    snap.latestVietnameseSegment === 'Hãy giới thiệu về bản thân bạn.');
ok('store exposes detectedQuestion',
    snap.detectedQuestion?.text === 'Erzählen Sie etwas über sich?');
ok('store recentSegments has both originals and translations',
    snap.recentSegments.length === 2
    && snap.recentSegments[0].text === 'Hallo, wie geht es dir?'
    && snap.recentSegments[1].translation === 'Hãy giới thiệu về bản thân bạn.');
ok('store hasContext after pushes', translatorContextStore.hasContext() === true);

// Cap behavior: a huge transcript should be tail-trimmed.
translatorContextStore.reset();
const big = 'a '.repeat(10000); // ~20000 chars
translatorContextStore.pushOriginal(big.trim(), 'en');
const cappedSnap = translatorContextStore.get();
ok('store caps fullTranscript length',
    cappedSnap.fullTranscript.length <= 8000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
