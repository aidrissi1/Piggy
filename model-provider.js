/**
 * Piggy — Model Provider
 * Abstracts vision model API calls. Supports OpenAI, Anthropic, Google Gemini.
 * Swap models without touching the AI controller.
 *
 * @author Idrissi
 * @license MIT
 */

'use strict';

/**
 * Create a model provider.
 * @param {string} provider - 'openai', 'anthropic', or 'gemini'
 * @param {string} apiKey
 * @param {object} [opts]
 * @param {string} [opts.model] - Override default model name
 * @returns {object} Provider with ask(systemPrompt, messages) method
 */
function createProvider(provider, apiKey, opts = {}) {
  switch (provider) {
    case 'openai':   return createOpenAI(apiKey, opts);
    case 'anthropic': return createAnthropic(apiKey, opts);
    case 'gemini':   return createGemini(apiKey, opts);
    default: throw new Error(`Unknown provider: ${provider}. Use 'openai', 'anthropic', or 'gemini'.`);
  }
}

// ── OpenAI (GPT-4o) ──────────────────────────────────────

function createOpenAI(apiKey, opts) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey });
  const model = opts.model || 'gpt-4o';

  return {
    name: 'openai',
    model,

    async ask(systemPrompt, history, currentImage, currentText, maxTokens = 500) {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        {
          role: 'user',
          content: [
            { type: 'text', text: currentText },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${currentImage}`, detail: 'low' } }
          ]
        }
      ];

      const res = await client.chat.completions.create({ model, max_tokens: maxTokens, messages });
      return res.choices[0]?.message?.content?.trim() || '';
    }
  };
}

// ── Anthropic (Claude) ───────────────────────────────────

function createAnthropic(apiKey, opts) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const model = opts.model || 'claude-sonnet-4-20250514';

  return {
    name: 'anthropic',
    model,

    async ask(systemPrompt, history, currentImage, currentText, maxTokens = 500) {
      // Convert history format: OpenAI style → Anthropic style
      const messages = [];
      for (const msg of history) {
        if (msg.role === 'user') {
          if (Array.isArray(msg.content)) {
            // Vision message with image
            const parts = [];
            for (const part of msg.content) {
              if (part.type === 'text') parts.push({ type: 'text', text: part.text });
              if (part.type === 'image_url') {
                const b64 = part.image_url.url.replace('data:image/png;base64,', '');
                parts.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } });
              }
            }
            messages.push({ role: 'user', content: parts });
          } else {
            messages.push({ role: 'user', content: msg.content });
          }
        } else if (msg.role === 'assistant') {
          messages.push({ role: 'assistant', content: msg.content });
        }
      }

      // Add current turn
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: currentText },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: currentImage } }
        ]
      });

      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages
      });

      return res.content[0]?.text?.trim() || '';
    }
  };
}

// ── Google Gemini ─────────────────────────────────────────

function createGemini(apiKey, opts) {
  const model = opts.model || 'gemini-2.0-flash';

  return {
    name: 'gemini',
    model,

    async ask(systemPrompt, history, currentImage, currentText, maxTokens = 500) {
      // Gemini uses REST API directly
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      // Build parts: system instruction + history text + current image
      const parts = [
        { text: systemPrompt + '\n\n' + currentText }
      ];

      // Add history as text context
      for (const msg of history) {
        const content = typeof msg.content === 'string' ? msg.content : msg.content?.[0]?.text || '';
        if (content) parts.push({ text: `${msg.role}: ${content}` });
      }

      // Add current screenshot
      parts.push({
        inline_data: {
          mime_type: 'image/png',
          data: currentImage
        }
      });

      const body = {
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: maxTokens }
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    }
  };
}

/**
 * Auto-detect provider from environment variables.
 * Checks OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY in order.
 * @returns {object|null} Provider or null if no key found
 */
function autoDetect() {
  if (process.env.OPENAI_API_KEY) return createProvider('openai', process.env.OPENAI_API_KEY);
  if (process.env.ANTHROPIC_API_KEY) return createProvider('anthropic', process.env.ANTHROPIC_API_KEY);
  if (process.env.GEMINI_API_KEY) return createProvider('gemini', process.env.GEMINI_API_KEY);
  return null;
}

module.exports = { createProvider, autoDetect };
