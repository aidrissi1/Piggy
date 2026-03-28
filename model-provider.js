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
      const userContent = [{ type: 'text', text: currentText }];
      if (currentImage) {
        userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${currentImage}`, detail: 'low' } });
      }

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userContent }
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

  // Tool definitions — the model MUST call one of these
  const TOOLS = [
    {
      name: 'click_element',
      description: 'Click on an element by its exact name from the element list. Use this to click buttons, links, search results.',
      input_schema: {
        type: 'object',
        properties: {
          element_name: { type: 'string', description: 'Exact name of the element from the element list' }
        },
        required: ['element_name']
      }
    },
    {
      name: 'click_and_type',
      description: 'Click on an input field and type text into it. Use this for search bars, form fields, address bars.',
      input_schema: {
        type: 'object',
        properties: {
          element_name: { type: 'string', description: 'Exact name of the input field from the element list' },
          text: { type: 'string', description: 'Text to type into the field' }
        },
        required: ['element_name', 'text']
      }
    },
    {
      name: 'press_key',
      description: 'Press a keyboard key. Use for enter, tab, escape, etc.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: ['enter', 'tab', 'escape', 'backspace', 'delete', 'space', 'up', 'down', 'left', 'right'] }
        },
        required: ['key']
      }
    },
    {
      name: 'scroll_page',
      description: 'Scroll the page up or down.',
      input_schema: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'] }
        },
        required: ['direction']
      }
    },
    {
      name: 'focus_app',
      description: 'Open or focus an application.',
      input_schema: {
        type: 'object',
        properties: {
          app_name: { type: 'string', description: 'Application name: Safari, Brave Browser, Terminal, Finder, etc.' }
        },
        required: ['app_name']
      }
    },
    {
      name: 'read_page',
      description: 'Extract and read the text content of the current web page. Use when the user asks for information from a website.',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'keyboard_shortcut',
      description: 'Press a keyboard shortcut. Only use when no clickable element exists.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The key to press' },
          modifiers: { type: 'array', items: { type: 'string', enum: ['command', 'control', 'shift', 'alt'] } }
        },
        required: ['key', 'modifiers']
      }
    },
    {
      name: 'task_complete',
      description: 'Declare the task is done. Include findings/report if the user asked for information.',
      input_schema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the task is complete' },
          report: { type: 'string', description: 'Findings or information gathered, if applicable' }
        },
        required: ['reason']
      }
    },
    {
      name: 'task_failed',
      description: 'Declare the task cannot be completed.',
      input_schema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the task failed' }
        },
        required: ['reason']
      }
    },
    {
      name: 'take_screenshot',
      description: 'Take a screenshot to see the current screen state. Use this when you need visual confirmation of what happened after an action, or when the element list is not enough to understand the page.',
      input_schema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'navigate_to',
      description: 'Navigate the browser directly to a URL. Use this instead of clicking the address bar and typing.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to navigate to (e.g. https://cnn.com)' }
        },
        required: ['url']
      }
    },
    {
      name: 'web_search',
      description: 'Search the web using SerpApi. Returns structured results with titles, links, and snippets. Use this for quick factual lookups instead of navigating to Google manually.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          num_results: { type: 'number', description: 'Number of results (1-10, default 5)' }
        },
        required: ['query']
      }
    },
    {
      name: 'recall_memory',
      description: 'Search your past experience and learned skills. Use when you encounter a familiar task or need to remember how you solved something before.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you want to recall (e.g. "how to search Google", "navigating in Brave")' }
        },
        required: ['query']
      }
    }
  ];

  /**
   * Convert OpenAI-style history to Anthropic format.
   */
  function convertHistory(history) {
    const messages = [];
    for (const msg of history) {
      if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
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
    return messages;
  }

  return {
    name: 'anthropic',
    model,

    /**
     * Standard text completion (used for chat mode).
     */
    async ask(systemPrompt, history, currentImage, currentText, maxTokens = 500) {
      const messages = convertHistory(history);
      const currentParts = [{ type: 'text', text: currentText }];
      if (currentImage) {
        currentParts.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: currentImage } });
      }
      messages.push({ role: 'user', content: currentParts });

      const res = await client.messages.create({
        model, max_tokens: maxTokens, system: systemPrompt, messages
      });
      return res.content[0]?.text?.trim() || '';
    },

    /**
     * Tool-use completion (used for task execution).
     * Forces the model to call exactly one tool — no narration possible.
     */
    async askWithTools(systemPrompt, history, currentImage, currentText, maxTokens = 500) {
      const messages = convertHistory(history);
      const currentParts = [{ type: 'text', text: currentText }];
      if (currentImage) {
        currentParts.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: currentImage } });
      }
      messages.push({ role: 'user', content: currentParts });

      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
        tools: TOOLS,
        tool_choice: { type: 'any' } // MUST call a tool
      });

      // Extract tool call
      const toolUse = res.content.find(c => c.type === 'tool_use');
      if (toolUse) {
        return { tool: toolUse.name, input: toolUse.input, raw: JSON.stringify(toolUse) };
      }

      // Fallback if no tool call (shouldn't happen with tool_choice: any)
      const text = res.content.find(c => c.type === 'text');
      return { tool: null, input: {}, raw: text?.text || '' };
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

      // Add current screenshot (if available)
      if (currentImage) {
        parts.push({
          inline_data: {
            mime_type: 'image/png',
            data: currentImage
          }
        });
      }

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
