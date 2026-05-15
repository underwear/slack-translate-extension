const LANGUAGES = {
  "Afrikaans": "af", "Albanian": "sq", "Amharic": "am", "Arabic": "ar", "Armenian": "hy",
  "Azerbaijani": "az", "Basque": "eu", "Belarusian": "be", "Bengali": "bn", "Bosnian": "bs",
  "Bulgarian": "bg", "Catalan": "ca", "Cebuano": "ceb", "Chinese (Simplified)": "zh-CN",
  "Chinese (Traditional)": "zh-TW", "Corsican": "co", "Croatian": "hr", "Czech": "cs",
  "Danish": "da", "Dutch": "nl", "English": "en", "Esperanto": "eo", "Estonian": "et",
  "Finnish": "fi", "French": "fr", "Frisian": "fy", "Galician": "gl", "Georgian": "ka",
  "German": "de", "Greek": "el", "Gujarati": "gu", "Haitian Creole": "ht", "Hausa": "ha",
  "Hawaiian": "haw", "Hebrew": "he", "Hindi": "hi", "Hmong": "hmn", "Hungarian": "hu",
  "Icelandic": "is", "Igbo": "ig", "Indonesian": "id", "Irish": "ga", "Italian": "it",
  "Japanese": "ja", "Javanese": "jv", "Kannada": "kn", "Kazakh": "kk", "Khmer": "km",
  "Kinyarwanda": "rw", "Korean": "ko", "Kurdish": "ku", "Kyrgyz": "ky", "Lao": "lo",
  "Latin": "la", "Latvian": "lv", "Lithuanian": "lt", "Luxembourgish": "lb", "Macedonian": "mk",
  "Malagasy": "mg", "Malay": "ms", "Malayalam": "ml", "Maltese": "mt", "Maori": "mi",
  "Marathi": "mr", "Mongolian": "mn", "Myanmar (Burmese)": "my", "Nepali": "ne", "Norwegian": "no",
  "Nyanja (Chichewa)": "ny", "Odia (Oriya)": "or", "Pashto": "ps", "Persian": "fa", "Polish": "pl",
  "Portuguese": "pt", "Punjabi": "pa", "Romanian": "ro", "Russian": "ru", "Samoan": "sm",
  "Scots Gaelic": "gd", "Serbian": "sr", "Sesotho": "st", "Shona": "sn", "Sindhi": "sd",
  "Sinhala (Sinhalese)": "si", "Slovak": "sk", "Slovenian": "sl", "Somali": "so", "Spanish": "es",
  "Sundanese": "su", "Swahili": "sw", "Swedish": "sv", "Tagalog (Filipino)": "tl", "Tajik": "tg",
  "Tamil": "ta", "Tatar": "tt", "Telugu": "te", "Thai": "th", "Turkish": "tr", "Turkmen": "tk",
  "Ukrainian": "uk", "Urdu": "ur", "Uyghur": "ug", "Uzbek": "uz", "Vietnamese": "vi",
  "Welsh": "cy", "Xhosa": "xh", "Yiddish": "yi", "Yoruba": "yo", "Zulu": "zu"
};

const DEFAULT_REWRITE_PROMPT = `You are a rewriting assistant inside a Slack composer for a US tech company.
Your only job: rewrite the user's draft into clear, casual-but-professional English suitable for coworker chat.

## Output rules
- Output ONLY the rewritten message. No preface, no explanation, no quotes around it.
- Preserve EXACTLY, character-for-character: @mentions (@name), channel refs (#channel), URLs, inline code in \`backticks\`, and fenced code blocks in triple backticks.
- Translate Russian (or any non-English) to English. If already English, just polish it.
- Tone: a competent coworker on Slack. Contractions are fine. No corporate fluff ("I hope this finds you well"), no emoji unless the draft had them.
- Keep it concise. Do not invent facts, names, dates, or numbers not in the draft.

## Formatting rules
- Use a numbered list (1. 2. 3.) when the draft describes a sequence of steps or an ordered procedure.
- Use a bulleted list (- ) when the draft lists parallel items of equal weight (3+ items).
- Otherwise use prose.
- Separate paragraphs with EXACTLY ONE blank line. Never two or more blank lines anywhere in the output.
- Do not wrap the whole message in a code block.

## Examples

Input:
надо задеплоить - сначала смержить PR в main, потом дождаться CI, потом нажать deploy в #releases. @john запулреквесть плз

Output:
@john please open the PR. To ship this:

1. Merge the PR into \`main\`.
2. Wait for CI to go green.
3. Hit deploy in #releases.

Input:
hey quick q — the api is returning 500 on /users endpoint, see https://example.com/logs/123 . i think its the new migration. cc @alex

Output:
Quick question — the API is returning 500 on \`/users\`, see https://example.com/logs/123. I think it's the new migration. cc @alex`;

const DEFAULTS = {
  nativeLanguage: 'ru',
  translateLabel: 'Translate',
  rewriteEnabled: true,
  rewritePrompt: DEFAULT_REWRITE_PROMPT,
};

const nativeSelect = document.querySelector('#native-language-dropdown');
const labelInput = document.querySelector('#translate-label');
const rewriteToggle = document.querySelector('#rewrite-enabled');
const rewritePrompt = document.querySelector('#rewrite-prompt');
const resetPromptBtn = document.querySelector('#reset-prompt-btn');
const resetBtn = document.querySelector('#reset-btn');
const refreshStatusBtn = document.querySelector('#refresh-status');
const prefetchBtn = document.querySelector('#prefetch-btn');
const modelsOverallSub = document.querySelector('#models-overall-sub');
const modelRows = document.querySelector('#model-rows');

// ---------- direct AI API access (options is top-level window, gestures preserved) ----------

const apiPresence = () => ({
  Translator: 'Translator' in self,
  LanguageDetector: 'LanguageDetector' in self,
  LanguageModel: 'LanguageModel' in self,
});

const downloadStates = new Map(); // key -> {status, progress, error}
const setState = (key, patch) => downloadStates.set(key, { ...(downloadStates.get(key) || {}), ...patch });

const trackedCreate = (key, factory) => {
  setState(key, { status: 'downloading', progress: 0, error: null });
  return factory({
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => setState(key, { status: 'downloading', progress: e.loaded }));
    },
  })
    .then((inst) => { setState(key, { status: 'available', progress: 1, error: null }); return inst; })
    .catch((err) => { setState(key, { status: 'error', error: String(err?.message || err) }); throw err; });
};

const availabilityOf = async (kind, opts) => {
  try {
    if (kind === 'translator') return await Translator.availability(opts);
    if (kind === 'detector') return await LanguageDetector.availability();
    if (kind === 'model') return await LanguageModel.availability();
  } catch { return 'unavailable'; }
};

const statusFor = async (key, kind, opts) => {
  const tracked = downloadStates.get(key);
  if (tracked && tracked.status === 'downloading') return tracked;
  const availability = await availabilityOf(kind, opts);
  return {
    status: availability,
    progress: tracked?.progress ?? (availability === 'available' ? 1 : 0),
    error: tracked?.error || null,
  };
};

const getStatus = async (nativeLanguage) => {
  const presence = apiPresence();
  const status = { apis: presence, models: {} };
  if (presence.LanguageDetector) status.models.detector = await statusFor('detector', 'detector');
  if (presence.LanguageModel) status.models.model = await statusFor('model', 'model');
  if (presence.Translator && nativeLanguage) {
    const pairs = [
      { source: 'en', target: nativeLanguage },
      { source: nativeLanguage, target: 'en' },
    ];
    status.models.translators = await Promise.all(
      pairs.map(async (p) => {
        if (p.source === p.target) return { ...p, status: 'available', progress: 1 };
        const key = `translator:${p.source}->${p.target}`;
        const s = await statusFor(key, 'translator', { sourceLanguage: p.source, targetLanguage: p.target });
        return { ...p, ...s };
      })
    );
  }
  return status;
};

// Triggered from a real button click — user gesture is alive here, so .create() will accept the download.
const prefetchModels = (nativeLanguage) => {
  if ('LanguageDetector' in self) {
    trackedCreate('detector', (opts) => LanguageDetector.create(opts)).catch(() => {});
  }
  if ('LanguageModel' in self) {
    trackedCreate('model', (opts) => LanguageModel.create(opts)).catch(() => {});
  }
  if ('Translator' in self && nativeLanguage && nativeLanguage !== 'en') {
    trackedCreate(`translator:en->${nativeLanguage}`, (opts) =>
      Translator.create({ sourceLanguage: 'en', targetLanguage: nativeLanguage, ...opts })
    ).catch(() => {});
    trackedCreate(`translator:${nativeLanguage}->en`, (opts) =>
      Translator.create({ sourceLanguage: nativeLanguage, targetLanguage: 'en', ...opts })
    ).catch(() => {});
  }
};

// ---------- models status UI ----------
const STATUS_LABELS = {
  available: { text: 'Ready', cls: 'ok' },
  downloading: { text: 'Downloading…', cls: 'busy' },
  downloadable: { text: 'Not downloaded', cls: 'warn' },
  unavailable: { text: 'Not supported on this device', cls: 'err' },
  error: { text: 'Error', cls: 'err' },
};

const renderProgress = (s) => {
  if (s.status === 'downloading') {
    const pct = Math.round((s.progress || 0) * 100);
    return `<div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div><div class="sub">${pct}%</div>`;
  }
  return '';
};

const renderRow = (name, hint, s) => {
  const label = STATUS_LABELS[s.status] || { text: s.status, cls: '' };
  return `<div class="card-row model-row">
    <div class="flex">
      <div>${name}</div>
      <div class="sub">${hint}</div>
      ${renderProgress(s)}
      ${s.error ? `<div class="sub err">${s.error}</div>` : ''}
    </div>
    <div class="status ${label.cls}">${label.text}</div>
  </div>`;
};

const renderStatus = (status) => {
  if (!status.apis) {
    modelsOverallSub.textContent = 'Status unavailable.';
    return;
  }
  const missing = Object.entries(status.apis).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length === 3) {
    modelsOverallSub.innerHTML = `Chrome built-in AI is not available on this device. Need Chrome 138+ on desktop, 22 GB free space, and possibly enable <code>chrome://flags/#prompt-api-for-gemini-nano</code>, <code>#translation-api</code>, <code>#language-detection-api</code>.`;
  } else if (missing.length) {
    modelsOverallSub.innerHTML = `Some APIs unavailable: ${missing.join(', ')}. Check flags in <code>chrome://flags</code>.`;
  } else {
    modelsOverallSub.textContent = 'All APIs detected. Click "Download models" if any show "Not downloaded".';
  }

  const rows = [];
  if (status.apis.LanguageDetector && status.models.detector) {
    rows.push(renderRow('Language Detector', 'Detects source language of any message', status.models.detector));
  }
  if (status.apis.LanguageModel && status.models.model) {
    rows.push(renderRow('Gemini Nano (Prompt API)', 'Used to polish your English when composing', status.models.model));
  }
  if (status.apis.Translator && status.models.translators) {
    status.models.translators.forEach((t) => {
      rows.push(renderRow(`Translator: ${t.source} → ${t.target}`, 'Pair model, ~30–100 MB', t));
    });
  }
  modelRows.innerHTML = rows.join('') || '<div class="card-row"><div class="flex sub">No API present.</div></div>';
};

const fetchStatus = async () => {
  try {
    const cfg = await new Promise((r) => chrome.storage.sync.get(DEFAULTS, r));
    const status = await getStatus(cfg.nativeLanguage);
    renderStatus(status);
    return status;
  } catch (err) {
    modelsOverallSub.textContent = `Error: ${err.message}`;
    return null;
  }
};

let pollTimer = null;
const startPolling = () => {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const status = await fetchStatus();
    if (!status) return;
    const anyDownloading = [
      status.models?.detector,
      status.models?.model,
      ...(status.models?.translators || []),
    ].some((m) => m && m.status === 'downloading');
    if (!anyDownloading) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 1000);
};

refreshStatusBtn.addEventListener('click', fetchStatus);
prefetchBtn.addEventListener('click', async () => {
  const cfg = await new Promise((r) => chrome.storage.sync.get(DEFAULTS, r));
  // Fire .create() calls synchronously inside the click handler so user activation is preserved.
  prefetchModels(cfg.nativeLanguage);
  startPolling();
  fetchStatus();
});

const populateLanguages = () => {
  const frag = document.createDocumentFragment();
  Object.entries(LANGUAGES)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([name, code]) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = name;
      frag.appendChild(opt);
    });
  nativeSelect.appendChild(frag);
};

const loadConfig = () => {
  chrome.storage.sync.get(DEFAULTS, (cfg) => {
    nativeSelect.value = cfg.nativeLanguage;
    labelInput.value = cfg.translateLabel;
    rewriteToggle.checked = !!cfg.rewriteEnabled;
    rewritePrompt.value = cfg.rewritePrompt || DEFAULT_REWRITE_PROMPT;
  });
};

const set = (key, value) => chrome.storage.sync.set({ [key]: value });

populateLanguages();
loadConfig();

nativeSelect.addEventListener('change', (e) => set('nativeLanguage', e.target.value));
labelInput.addEventListener('blur', (e) => set('translateLabel', e.target.value || DEFAULTS.translateLabel));
rewriteToggle.addEventListener('change', (e) => set('rewriteEnabled', e.target.checked));
rewritePrompt.addEventListener('blur', (e) => set('rewritePrompt', e.target.value.trim() || DEFAULT_REWRITE_PROMPT));
resetPromptBtn.addEventListener('click', () => {
  rewritePrompt.value = DEFAULT_REWRITE_PROMPT;
  set('rewritePrompt', DEFAULT_REWRITE_PROMPT);
});

resetBtn.addEventListener('click', () => {
  chrome.storage.sync.set(DEFAULTS, () => loadConfig());
});

fetchStatus();
nativeSelect.addEventListener('change', () => fetchStatus());
