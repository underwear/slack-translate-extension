// Slack Local AI — content script.
// Injects:
//   1) "Translate" link under each incoming message (translates to user's target language)
//   2) "✨ Rewrite in English" icon button in the composer (auto: translates non-English / improves English)

const CLS = {
  translateBtn: 'sla-translate-btn',
  translateDone: 'sla-translate-done',
  rewriteBtn: 'sla-rewrite-btn',
  rewriteBtnInjected: 'sla-rewrite-btn-injected',
};

const SELECTORS = {
  messageBlock: '.p-rich_text_block',
  messageAttachments: '.c-message_kit__attachments',
  composerSuffix: '[data-qa="wysiwyg-container_suffix"]',
  composerEditor: '.ql-editor',
  scrollContainers: [
    '.p-workspace__primary_view_body',
    '.p-view_contents--secondary',
    '.c-virtual_list__scroll_container',
  ],
};

const DEFAULT_CONFIG = {
  nativeLanguage: 'ru', // your mother tongue — used as target for incoming translations
  translateLabel: 'Translate',
  translateEngine: 'translator', // 'translator' — better quality, flattens formatting
                                 // 'nano'       — Gemini Nano, preserves lists & line breaks
  rewriteEnabled: true,
  rewritePrompt: '', // empty = use ai-runner default
};

let config = { ...DEFAULT_CONFIG };

// ---------- AI runner bridge (postMessage to MAIN-world script) ----------
// MAIN world is required so AI API .create() calls preserve user activation.

const REQ = 'sla:request';
const RES = 'sla:response';
let _reqSeq = 0;
const _pending = new Map();

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.kind !== RES) return;
  const entry = _pending.get(msg.id);
  if (!entry) return;
  _pending.delete(msg.id);
  if (msg.error) entry.reject(new Error(msg.error));
  else entry.resolve(msg.result);
});

const callAiRunner = (action, payload) =>
  new Promise((resolve, reject) => {
    const id = ++_reqSeq;
    _pending.set(id, { resolve, reject });
    window.postMessage({ kind: REQ, id, action, payload }, '*');
    setTimeout(() => {
      if (_pending.has(id)) {
        _pending.delete(id);
        reject(new Error('AI runner timeout'));
      }
    }, 120000);
  });

// ---------- Translate button on incoming messages ----------

const extractMessageText = (messageEl) => {
  const clone = messageEl.cloneNode(true);
  clone.querySelectorAll('.c-message_attachment_with_pretext').forEach((e) => e.remove());
  clone.querySelectorAll('.c-message_attachment').forEach((e) => {
    if (/^\d+ previous repl(y|ies)$/.test(e.textContent || '')) e.remove();
  });
  clone.querySelector('.c-message__edited_label')?.remove();
  clone.querySelectorAll(`.${CLS.translateBtn}, .${CLS.translateDone}`).forEach((e) => e.remove());
  // innerText preserves visual line breaks unlike textContent
  return (clone.innerText || '').trim();
};

const injectTranslateButton = (messageEl) => {
  if (messageEl.dataset.slaInjected) return;
  messageEl.dataset.slaInjected = '1';

  const text = extractMessageText(messageEl);
  if (!text) return;

  const btn = document.createElement('div');
  btn.className = CLS.translateBtn;
  btn.textContent = config.translateLabel;
  btn.addEventListener(
    'click',
    async () => {
      const original = btn.textContent;
      btn.textContent = '…';
      try {
        const { text: translated, skipped, sourceLanguage } = await callAiRunner('translate', {
          text,
          targetLanguage: config.nativeLanguage,
          engine: config.translateEngine,
        });
        const done = document.createElement('div');
        done.className = CLS.translateDone;
        done.textContent = translated;
        if (skipped) done.dataset.skipped = '1';
        if (sourceLanguage) done.dataset.lang = sourceLanguage;
        btn.replaceWith(done);
      } catch (err) {
        console.error('[slack-local-ai] translate failed', err);
        btn.textContent = original;
        btn.dataset.error = String(err.message || err);
      }
    },
    { once: true }
  );
  messageEl.appendChild(btn);
};

const scanForMessages = (root) => {
  const messages = [
    ...root.querySelectorAll(SELECTORS.messageBlock),
    ...root.querySelectorAll(SELECTORS.messageAttachments),
  ];
  messages.forEach(injectTranslateButton);
};

// ---------- Rewrite button in composer ----------

const replaceComposerText = (editor, newText) => {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  // execCommand still works in Chrome and lets Quill register the change properly
  document.execCommand('insertText', false, newText);
};

const buildRewriteButton = () => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `c-button-unstyled c-icon_button c-icon_button--size_x-small ${CLS.rewriteBtn}`;
  btn.setAttribute('aria-label', 'Rewrite in English');
  btn.title = 'Rewrite in English';
  btn.innerHTML = '<span class="sla-rewrite-icon" aria-hidden="true">✨</span>';

  btn.addEventListener('click', async () => {
    const editor = btn.closest('.c-wysiwyg_container')?.querySelector(SELECTORS.composerEditor);
    if (!editor) return;
    const text = (editor.innerText || '').trim();
    if (!text) return;

    btn.disabled = true;
    btn.dataset.loading = '1';
    try {
      const { text: rewritten } = await callAiRunner('rewriteEnglish', {
        text,
        prompt: config.rewritePrompt || undefined,
      });
      if (rewritten) replaceComposerText(editor, rewritten);
    } catch (err) {
      console.error('[slack-local-ai] rewrite failed', err);
      btn.dataset.error = '1';
      setTimeout(() => delete btn.dataset.error, 2000);
    } finally {
      btn.disabled = false;
      delete btn.dataset.loading;
    }
  });

  return btn;
};

const injectRewriteIntoSuffix = (suffix) => {
  if (!config.rewriteEnabled) return;
  if (suffix.classList.contains(CLS.rewriteBtnInjected)) return;
  suffix.classList.add(CLS.rewriteBtnInjected);
  const btn = buildRewriteButton();
  // Insert as the first child of suffix so Rewrite sits to the left of Send
  suffix.prepend(btn);
};

const scanForComposers = (root) => {
  root.querySelectorAll(SELECTORS.composerSuffix).forEach(injectRewriteIntoSuffix);
};

// ---------- bootstrap ----------

const startObserver = (selector) => {
  const tryAttach = () => {
    const view = document.querySelector(selector);
    if (!view) return setTimeout(tryAttach, 2000);
    scanForMessages(view);
    scanForComposers(view);
    const observer = new MutationObserver(() => {
      scanForMessages(view);
      scanForComposers(view);
    });
    observer.observe(view, { childList: true, subtree: true });
  };
  tryAttach();
};

const startGlobalComposerObserver = () => {
  scanForComposers(document.body);
  const observer = new MutationObserver(() => scanForComposers(document.body));
  observer.observe(document.body, { childList: true, subtree: true });
};

chrome.storage.sync.get(DEFAULT_CONFIG, (stored) => {
  config = { ...DEFAULT_CONFIG, ...stored };
  SELECTORS.scrollContainers.forEach(startObserver);
  startGlobalComposerObserver();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [k, v] of Object.entries(changes)) {
    config[k] = v.newValue;
  }
});
