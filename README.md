# Translator + Realtime Interview Assistant

> A fork-extension of [phuc-nt/my-translator](https://github.com/phuc-nt/my-translator) (MIT) that keeps the original real-time speech translator and adds an **Interview Assistant Mode** powered by your own ChatGPT account.

The original My Translator is a Tauri 2 desktop app (Rust backend + WebView frontend) that captures system audio or microphone audio, transcribes/translates it via Soniox, and renders the result in a minimal overlay. This project keeps **all** of those features intact and adds a new "Interview Assistant" view, an Auto-Detect-Question pipeline, and a fully ethical "ChatGPT Account Manual Mode" prompt workflow.

## Status of the upstream features

Everything that worked in `my-translator` still works here:

- Real-time speech capture (system audio on macOS via ScreenCaptureKit / Windows via WASAPI; microphone via cpal)
- Soniox-based STT + translation, with the existing dual-panel overlay UI
- Edge / Google / ElevenLabs TTS providers
- Sessions list, transcript saving, Settings tab structure, auto-updater plumbing
- macOS Apple-Silicon-only Local MLX mode

> **Important note about ChatGPT / GPT.** This app uses the GPT API via your own API key (OpenAI or any OpenAI-compatible provider). It does **not** use a ChatGPT account, ChatGPT webview, browser cookies, or DOM automation. The optional Manual Mode opens `chatgpt.com` in your normal browser; the optional Combined Mode calls `${GPT_BASE_URL}/chat/completions` directly with a Bearer token you configure.

## What's new — Interview Assistant Mode

The Interview Assistant is opened from the speech-bubble icon in the overlay control bar (or pre-emptively while the translator is running, via Combined Mode).

### Section A — Input Question

- Free-form textarea for the question
- **Use Latest Transcript** button pulls the most recent transcript text into the textarea
- Auto Detect Question toggle (default: ON) + a status pill that mirrors the detector state (`Listening for questions` → `Waiting for complete question` → `Question detected` / `No question detected`)

### Section B — Question Translation

- Detected source language (English / German / Vietnamese / Unknown)
- Vietnamese translation (mirror when source is Vietnamese; otherwise we delegate translation to ChatGPT inside the prompt)

### Section C — Answer Settings

Dropdowns for: target answer language, answer length, language level, answer style, interview type. All choices match the project spec.

### Section D — User Context

Free-form personal context (background, experience, strengths, career goals, target industry).

### Section E — Generated ChatGPT Prompt

The Generate Prompt button builds the full prompt using the template from the spec — including the explicit anti-cheating clause — and renders it in a read-only textarea. **Copy Prompt** copies it to your clipboard. **Open ChatGPT** launches `https://chatgpt.com` in your default browser via the Tauri opener plugin.

### Section F — Paste ChatGPT Answer

Once you have an answer from ChatGPT, paste it back into the textarea and click **Save Answer** to attach it to the most recently generated history entry. **Copy Answer** / **Clear Answer** are also provided.

### Section G — Interview History

Local-only (browser `localStorage`) history of every prompt + answer pair. Search, copy, delete, clear, and export to JSON or TXT. No data ever leaves the machine.

## Auto-Detect-Question pipeline

A snippet is treated as a question if it ends with `?`, or starts with one of the multilingual cue phrases the spec defines (English: `What`, `Why`, `How`, `When`, `Where`, `Who`, `Which`, `Can you`, `Could you`, `Do you`, `Did you`, `Have you`, `Are you`, `Tell me about`; German: `Warum`, `Wie`, `Wann`, `Wo`, `Wer`, `Was`, `Welche`, `Können Sie`, `Kannst du`, `Haben Sie`, `Sind Sie`, `Erzählen Sie`; Vietnamese: `Tại sao`, `Vì sao`, `Như thế nào`, `Khi nào`, `Ở đâu`, `Ai`, `Cái gì`, `Bạn có thể`, `Bạn đã`, `Hãy kể`, `Hãy giới thiệu`).

Implementation details:

- 2 s debounce after the last transcript update (configurable, 0.5–10 s)
- Minimum length of 10 characters to filter out single-word fragments (configurable)
- Duplicate guard with normalized-text hash + Dice-bigram similarity, threshold 0.85 by default — so "Tell me about your strengths" and "Tell me about your strength" are collapsed into one detection

When a fresh question is found, it's auto-filled into the Interview view's question box and a prompt is pre-built so you only have to click **Copy Prompt** + **Open ChatGPT**.

## Combined Mode

If Combined Mode is enabled (default: ON) the auto-detect pipeline runs while you are still in the Translator overlay — so the moment the speaker asks a question, the Interview view already has the question + ready-to-copy prompt waiting for you. There is **one** audio/transcript stream; we do not start a second microphone or duplicate any audio processing.

If you also configure a **GPT API key** in Settings → Interview, Combined Mode will additionally call the model directly (via the OpenAI-compatible REST API you point it at) and render a structured suggested answer right in the Interview view — short answer, full answer, Vietnamese translation, vocabulary list, confidence score. See **Combined Mode with GPT API** below.

## Combined Mode with GPT API

When the optional GPT API integration is enabled, the pipeline becomes:

```
Audio Input
  → Soniox real-time transcription
  → auto language detection
  → Vietnamese translation (existing translator)
  → Translator panel
  → If Interview Mode is ON:
      → Detect interview question (multilingual cues + ?)
      → Build GPT chat-completions request
      → POST ${GPT_BASE_URL}/chat/completions  (Bearer ${GPT_API_KEY})
      → Parse JSON answer
      → Render suggested answer in the Interview Assistant panel
```

This is **not** a ChatGPT-account flow. We call the standard OpenAI REST API, which is supported by:

- OpenAI directly (`https://api.openai.com/v1`)
- Azure OpenAI (compatible mode)
- Any OpenAI-compatible provider — Groq, Together, OpenRouter, Mistral La Plateforme, local `llama.cpp` server, Ollama with the OpenAI shim, …

You only have to change `GPT_BASE_URL` to point at the right base.

The model is asked to return one of two JSON shapes:

- An interview answer object (`is_interview_question: true` plus `short_answer`, `full_answer`, `answer_vi`, `important_vocabulary`, `confidence`, …)
- A "not a question" object (`is_interview_question: false`, `reason`, `confidence`)

The app parses JSON safely. If parsing fails, it retries the request once with an explicit "reply with valid JSON only" reminder. If the second response still fails to parse, the app shows a friendly error message and lets the user click **Regenerate**.

### Anti-spam guarantees

- 1.5–3 s debounce after the last transcript update (configurable)
- The detector skips fragments under `gptMinWords` (default 5 words)
- The most recent ~10 questions are cached by FNV-1a fingerprint + Dice-bigram similarity (≥ 0.85), so the same question never spends two API calls
- An in-flight request is aborted as soon as a fresher question arrives
- Optional toggle: **Auto-call GPT on detected question** (default ON). Off → the app only fills in the question and waits for the user to press **Generate Answer**

### Configuration

Configure either inside the app (Settings → Interview → Combined Mode (GPT API)) or by copying `.env.example` to `.env` and filling in:

```
SONIOX_API_KEY=your_soniox_api_key_here
GPT_API_KEY=your_gpt_api_key_here
GPT_BASE_URL=https://api.openai.com/v1
GPT_MODEL=gpt-4o-mini
```

`.env` is git-ignored. The app reads these values from `localStorage` at runtime — the `.env` file is a convenience for advanced users; the in-app Settings UI is the canonical store.

The API-key field is masked everywhere in the UI (`sk-****abcd`) and is never logged.

### Interview Context

In the same settings panel you can fill in:

- **Target answer language** — Deutsch / English / Vietnamese (default Deutsch)
- **Language level** — A1 / A2 / A2-B1 / B1 / B2 (default A2-B1)
- **Ausbildung / Beruf** (default `Maschinen- und Anlagenführer`)
- **Company name** (default `Teledoor`)
- **User background** — free text
- **Strengths** — free text
- **Work experience** — free text

These values are interpolated into the GPT prompt so suggestions are tailored to your situation.

### Common errors

- *"Vui lòng nhập SONIOX_API_KEY trong Settings."* — fill in the Soniox key under Translation settings (unchanged from upstream).
- *"Vui lòng nhập GPT_API_KEY trong Settings để tạo câu trả lời gợi ý."* — Combined Mode needs a GPT key. Either configure one or stick with Manual Mode (Section E "Open ChatGPT").
- *"Không thể nhận diện âm thanh. Vui lòng kiểm tra microphone hoặc SONIOX_API_KEY."* — microphone permission denied or Soniox key invalid.
- *"Không thể tạo câu trả lời gợi ý. Vui lòng kiểm tra GPT_API_KEY, GPT_BASE_URL hoặc GPT_MODEL."* — HTTP 4xx/5xx from the GPT endpoint. Click the error to see the raw status. The most common cause is a typo in the base URL or an unsupported model name.
- *Offline* — the request fails with a network error and the panel goes into the `error` state. Reconnect and click **Regenerate**.

## ChatGPT Account Manual Mode — what we deliberately do NOT do

We use ChatGPT through the **public ChatGPT website**, signed in by you, in your default browser. That means the app:

- ✗ Never stores your ChatGPT password
- ✗ Never reads or stores ChatGPT cookies or session tokens
- ✗ Never automates or scrapes `chatgpt.com`
- ✗ Never bypasses Cloudflare, captcha, login, or rate limits
- ✗ Never simulates user input on the ChatGPT page
- ✓ Generates a complete, copy-pasteable prompt for you
- ✓ Opens `chatgpt.com` in your normal browser when you click Open ChatGPT
- ✓ Lets you paste the answer back, and saves it locally to the history

## Ethics & Disclaimer (from the in-app banner)

> Interview Assistant Mode được thiết kế để luyện tập phỏng vấn, chuẩn bị câu trả lời, học ngôn ngữ và ghi chú cá nhân. Không sử dụng app để gian lận, giả mạo, né giám sát hoặc vi phạm quy định của buổi phỏng vấn.

We do not build stealth mode, hidden overlays, anti-detection helpers, automated answers, or any cookie / session automation for ChatGPT.

## Settings (Settings → Interview tab)

- Enable Interview Assistant Mode (master switch)
- Enable Auto Detect Question (default: ON)
- Enable Combined Mode (default: ON)
- Question detection debounce in ms (default 2000)
- Duplicate similarity threshold (default 0.85)
- Minimum question length (default 10)
- ChatGPT URL (default `https://chatgpt.com`)
- Open ChatGPT in default browser (default ON)
- Auto copy generated prompt (default OFF)
- Save prompts to history (default ON)
- Save pasted answers to history (default ON)

Settings are stored in `localStorage` (key `translator_interview_settings_v1`). The original Rust-backed translator settings are untouched.

## Code structure (new pieces)

```
src/js/
  utils/
    textSimilarity.js       — Dice-bigram similarity + Vietnamese-safe normalization
    hashUtils.js            — FNV-1a fingerprint for duplicate detection
    languageUtils.js        — EN/DE/VI detection + multilingual cue lists
  services/interview/
    promptBuilder.js        — Builds the ChatGPT prompt from the spec template
    questionDetector.js     — Sentence splitter + cue/?-based detector + debounced pipeline
    duplicateQuestionGuard.js — Ring-buffer guard, hash + similarity threshold
    interviewHistoryService.js — Façade over the storage layer
  storage/
    interviewSettingsStorage.js — localStorage-backed settings (no backend changes)
    interviewHistoryStorage.js  — localStorage-backed history (no backend changes)
  components/interview/
    InterviewAssistantPanel.js  — Wires the static markup (`#interview-view`) to services
src/styles/interview.css      — All Interview-specific styling, scoped to `.iv-*`
```

The original Rust backend (`src-tauri/`) is **unchanged** apart from the project metadata renames (package name, identifier, window title). No new Tauri commands were added — everything new lives in the frontend.

## Original Project License

Original code: MIT License — Copyright (c) 2026 Personal Translator Contributors. The MIT license explicitly permits use, copy, modify, merge, publish, distribute, sublicense and sale of the software, so this fork is allowed; see the included [LICENSE](./LICENSE) file. We acknowledge the upstream project [phuc-nt/my-translator](https://github.com/phuc-nt/my-translator) prominently in the About tab.

---

## Installation & running on Windows

> **Pre-requisites** (one-time):
> - Node.js 18 or newer — https://nodejs.org/en/download
> - Rust stable toolchain — install with `winget install Rustlang.Rustup` then `rustup default stable` in a new terminal
> - Microsoft Visual Studio 2022 Build Tools with the **Desktop development with C++** workload (required by the Tauri Windows build chain)
> - WebView2 runtime (already present on Windows 10/11; otherwise grab the Evergreen installer from Microsoft)

Once those are installed, open **PowerShell** (or any shell) inside the project folder and run:

```powershell
# 1. install JS dependencies
npm install

# 2. start the app in development mode (Tauri dev server + native window)
npm run dev
```

The first `npm run dev` will compile the Rust backend; subsequent runs are incremental and start in a few seconds.

Other useful scripts:

```powershell
# build a production binary + installer (msi / nsis)
npm run build

# raw Tauri CLI
npm run tauri -- info
```

## Translator Mode — quick start (unchanged from upstream)

1. Launch the app
2. Open **Settings** → **Translation** and paste your Soniox API key
3. Pick source/target language
4. Click ▶ in the overlay control bar to start capturing system audio
5. The transcript + translation appears live; toggle dual view via the panel button

See [docs/installation_guide_win.md](docs/installation_guide_win.md) for a deeper Windows install walkthrough kept verbatim from upstream.

## Interview Assistant Mode — full workflow

1. Open the speech-bubble icon (Interview Assistant) in the overlay control bar
2. Either:
   - type the question into **Section A**, or
   - hit **Use Latest Transcript** to pull from the running translator, or
   - leave **Auto Detect Question** on and let it auto-fill from speech
3. Adjust **Answer Settings** (target language, length, level, style, interview type)
4. Add any personal background in **User Context**
5. Click **Generate Prompt** — the full prompt appears in **Section E**
6. Click **Copy Prompt** then **Open ChatGPT** — sign in with your own account
7. Paste the prompt into ChatGPT, copy ChatGPT's answer
8. Paste the answer back into **Section F** and click **Save Answer**
9. Browse / search / export your full history in **Section G**

## Combined Mode

When Combined Mode is enabled (default ON), the question-detection pipeline runs while you are still on the Translator overlay. The first time it sees a complete interview-style question it pre-fills the Interview Assistant view + builds a prompt — so when you switch to that view it's already ready to Copy + Open ChatGPT.

## Privacy

- All Interview-Assistant data lives in your browser's `localStorage` (the embedded WebView's storage), keyed by `translator_interview_settings_v1` and `translator_interview_history_v1`.
- The original translator's API keys still live in the Rust-managed settings file (unchanged).
- ChatGPT credentials are never stored, read, or transmitted by this app.

## Acknowledgements

This project is a derivative work of [phuc-nt/my-translator](https://github.com/phuc-nt/my-translator) (MIT), kept fully compatible with its existing API key flows, transcript pipeline, sessions storage, and settings format.
