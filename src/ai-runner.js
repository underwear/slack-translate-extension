// Runs in the page's MAIN world so that:
//  1) Chrome built-in AI APIs (Translator/LanguageDetector/LanguageModel) are reachable
//  2) User activation from click handlers is preserved when calling .create()
// Communicates with the isolated-world content script via window.postMessage.

(() => {
  const REQ = 'sla:request';
  const RES = 'sla:response';

  // System prompt for Gemini Nano. Lives in initialPrompts (system role) — Chrome
  // recommends this slot for instructions; gives faster first prompt and stronger
  // adherence than stuffing rules into the user turn. Format follows Google's
  // "use ## delimiters" guidance for Nano, with 2 few-shot examples (1 numbered
  // list, 1 prose) — small models follow the closest example by shape, more than
  // 2-3 leads to mimicry/overfitting.
  // Translate prompt — preserves formatting (lists, paragraphs, mentions). Used as the
  // primary path for incoming-message translation because Translator API mangles
  // multi-paragraph structure. Target language is filled in per call.
  const TRANSLATE_PROMPT = (targetName) => `You are a translator inside a Slack client.
Translate the user's message into ${targetName}.

## Rules
- Translate accurately and naturally — sound like a native ${targetName} speaker writing on Slack.
- PRESERVE FORMATTING EXACTLY: line breaks, blank lines between paragraphs, numbered lists ("1." "2."), bulleted lists ("-"), and the position of each item.
- Preserve character-for-character: @mentions (@name), #channel refs, URLs, inline code in \`backticks\`, fenced code blocks in triple backticks, and any product/code identifiers (V1, V2, ASAP, MVP, API names).
- Output ONLY the translated text. No preface, no quotes, no explanations, no "Here is the translation".

## Examples

Input:
This is kind of the roadmap:
1. Subscription AI video + image (standalone) need this asap
2. Subscription + AI Video + image + Zendrop bundle
3. Subscription + AI Video + image + Avatars

Output:
Это что-то вроде дорожной карты:
1. Subscription AI video + image (отдельно) — нужно это ASAP
2. Subscription + AI Video + image + Zendrop bundle
3. Subscription + AI Video + image + Avatars

Input:
Quick question — the API is returning 500 on \`/users\`, see https://example.com/logs/123. I think it's the new migration. cc @alex

Output:
Быстрый вопрос — API возвращает 500 на \`/users\`, см. https://example.com/logs/123. Думаю, дело в новой миграции. cc @alex`;

  // Friendly target-language names for the translate prompt
  const LANG_NAMES = {
    ru: 'Russian', en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
    pt: 'Portuguese', pl: 'Polish', uk: 'Ukrainian', tr: 'Turkish', nl: 'Dutch', sv: 'Swedish',
    fi: 'Finnish', da: 'Danish', no: 'Norwegian', cs: 'Czech', sk: 'Slovak', ro: 'Romanian',
    hu: 'Hungarian', bg: 'Bulgarian', el: 'Greek', he: 'Hebrew', ar: 'Arabic', fa: 'Persian',
    hi: 'Hindi', bn: 'Bengali', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay',
    ja: 'Japanese', ko: 'Korean', 'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese',
  };
  const langName = (code) => LANG_NAMES[code] || code;

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

  const translatorCache = new Map();
  let detectorPromise = null;
  // Cache sessions per system-prompt so user edits in options take effect on next call
  // (sessions are recreated when the prompt string changes).
  const modelSessions = new Map();
  let currentSystemPrompt = null;

  const heuristicDetect = (text) => {
    if (/[Ѐ-ӿ]/.test(text)) return { detectedLanguage: 'ru', confidence: 0.9, fallback: true };
    if (/[一-鿿]/.test(text)) return { detectedLanguage: 'zh', confidence: 0.9, fallback: true };
    if (/[぀-ゟ゠-ヿ]/.test(text)) return { detectedLanguage: 'ja', confidence: 0.9, fallback: true };
    if (/[가-힯]/.test(text)) return { detectedLanguage: 'ko', confidence: 0.9, fallback: true };
    if (/[֐-׿]/.test(text)) return { detectedLanguage: 'he', confidence: 0.9, fallback: true };
    if (/[؀-ۿ]/.test(text)) return { detectedLanguage: 'ar', confidence: 0.9, fallback: true };
    return { detectedLanguage: 'en', confidence: 0.6, fallback: true };
  };

  const getDetector = () => {
    if (!('LanguageDetector' in window)) throw new Error('LanguageDetector API not present');
    if (!detectorPromise) detectorPromise = LanguageDetector.create();
    return detectorPromise;
  };

  const getTranslator = (sourceLanguage, targetLanguage) => {
    if (!('Translator' in window)) throw new Error('Translator API not present');
    const key = `${sourceLanguage}->${targetLanguage}`;
    if (!translatorCache.has(key)) {
      translatorCache.set(key, Translator.create({ sourceLanguage, targetLanguage }));
    }
    return translatorCache.get(key);
  };

  const getModel = (systemPrompt) => {
    if (!('LanguageModel' in window)) throw new Error('LanguageModel (Prompt API) not present');
    if (!modelSessions.has(systemPrompt)) {
      // Some Nano builds reject expectedInputs.languages with NotSupportedError.
      // Try the rich config first; on failure fall back to the minimal one.
      const base = {
        initialPrompts: [{ role: 'system', content: systemPrompt }],
        temperature: 0.3,
        topK: 3,
      };
      // We don't declare expectedOutputs.languages because Nano may need to emit
      // many possible target languages (translate handler). Some builds also reject
      // expectedInputs.languages entirely — fall back without them on NotSupportedError.
      const session = LanguageModel.create({
        ...base,
        expectedInputs: [{ type: 'text', languages: ['ru', 'en'] }],
      }).catch((err) => {
        if (err?.name === 'NotSupportedError' || /language options/i.test(err?.message || '')) {
          console.warn('[slack-local-ai] expectedInputs languages unsupported, retrying without them');
          return LanguageModel.create(base);
        }
        throw err;
      });
      modelSessions.set(systemPrompt, session);
    }
    return modelSessions.get(systemPrompt);
  };

  const detectLang = async (text) => {
    if ('LanguageDetector' in window) {
      try {
        const detector = await getDetector();
        const results = await detector.detect(text);
        if (results && results[0]) return results[0];
      } catch (err) {
        console.warn('[slack-local-ai] LanguageDetector failed, using heuristic', err);
      }
    }
    return heuristicDetect(text);
  };

  // Belt-and-suspenders: even with explicit "single blank line" instruction,
  // small models occasionally emit \n\n\n. Collapse on the way out.
  const cleanOutput = (s) => (s || '').replace(/\n{3,}/g, '\n\n').trim();

  const handlers = {
    async ping() {
      return {
        ok: true,
        apis: {
          Translator: 'Translator' in window,
          LanguageDetector: 'LanguageDetector' in window,
          LanguageModel: 'LanguageModel' in window,
        },
      };
    },

    // engine: 'translator' (default, high-quality but flattens formatting)
    //       | 'nano'       (Gemini Nano, preserves lists/paragraphs, lower translation quality)
    async translate({ text, targetLanguage, engine }) {
      const detected = await detectLang(text);
      if (!detected || !detected.detectedLanguage) throw new Error('Cannot detect source language');
      if (detected.detectedLanguage === targetLanguage) {
        return { text, sourceLanguage: detected.detectedLanguage, skipped: true };
      }

      const useNano = engine === 'nano' && 'LanguageModel' in window;

      if (useNano) {
        try {
          const session = await getModel(TRANSLATE_PROMPT(langName(targetLanguage)));
          const userTurn = `Translate the message below into ${langName(targetLanguage)}. Output only the translation.\n\n<message>\n${text}\n</message>`;
          const out = await session.prompt(userTurn);
          return { text: cleanOutput(out), sourceLanguage: detected.detectedLanguage, mode: 'nano' };
        } catch (err) {
          console.warn('[slack-local-ai] Nano translate failed, falling back to Translator API', err);
        }
      }

      const translator = await getTranslator(detected.detectedLanguage, targetLanguage);
      const translated = await translator.translate(text);
      return { text: translated, sourceLanguage: detected.detectedLanguage, mode: 'translator' };
    },

    async rewriteEnglish({ text, prompt }) {
      const systemPrompt = prompt || DEFAULT_REWRITE_PROMPT;
      const detected = await detectLang(text);
      const src = detected?.detectedLanguage;

      if ('LanguageModel' in window) {
        try {
          const session = await getModel(systemPrompt);
          // Wrap the draft in <draft> tags so Nano never confuses draft content
          // for instructions (basic prompt-injection defense).
          const userTurn = `Rewrite the draft below following all rules. Output only the rewritten message.\n\n<draft>\n${text}\n</draft>`;
          const out = await session.prompt(userTurn);
          return { text: cleanOutput(out), mode: 'rewrite', sourceLanguage: src };
        } catch (err) {
          console.warn('[slack-local-ai] LanguageModel failed, falling back to Translator', err);
        }
      }

      if (src && src !== 'en') {
        const translator = await getTranslator(src, 'en');
        const translated = await translator.translate(text);
        return { text: translated, mode: 'translate-fallback', sourceLanguage: src };
      }
      return { text, mode: 'noop', sourceLanguage: src, note: 'No model available to rewrite English text' };
    },
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.kind !== REQ) return;
    const { id, action, payload } = msg;
    const fn = handlers[action];
    if (!fn) {
      window.postMessage({ kind: RES, id, error: `Unknown action: ${action}` }, '*');
      return;
    }
    try {
      const result = await fn(payload || {});
      window.postMessage({ kind: RES, id, result }, '*');
    } catch (err) {
      window.postMessage({ kind: RES, id, error: String(err?.message || err) }, '*');
    }
  });
})();
