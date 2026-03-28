/**
 * Piggy — Context Window Manager
 * Manages AI conversation history intelligently.
 * Summarizes old steps, keeps relevant context, prunes screenshots.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

// ── Importance levels ────────────────────────────────────

const IMPORTANCE = {
  CRITICAL: 4,  // errors, task completion, user instructions
  HIGH: 3,      // element discoveries, page reads, navigation results
  MEDIUM: 2,    // successful actions, clicks, typing
  LOW: 1        // repeated scans, redundant focus, status checks
};

/**
 * Create a new context manager instance.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxMessages=30] — max messages before pruning
 * @param {number} [opts.maxTokens=50000] — approximate max tokens
 * @param {number} [opts.keepRecent=8] — always keep last N exchanges
 * @param {number} [opts.maxScreenshots=2] — keep only last N screenshots
 * @returns {object} — context manager instance
 */
function create(opts = {}) {
  const config = {
    maxMessages: opts.maxMessages || 30,
    maxTokens: opts.maxTokens || 50000,
    keepRecent: opts.keepRecent || 8,
    maxScreenshots: opts.maxScreenshots || 2
  };

  const messages = [];    // { role, content, metadata }
  const summaries = [];   // compressed old context
  let totalPruned = 0;

  // ── Add message ──────────────────────────────────────

  /**
   * Add a message to history.
   *
   * @param {string} role — 'user' | 'assistant' | 'system'
   * @param {*} content — string or array (multimodal)
   * @param {object} [metadata]
   * @param {number} [metadata.step] — step number
   * @param {string} [metadata.actionType] — what action was taken
   * @param {boolean} [metadata.hasScreenshot] — contains an image
   * @param {boolean} [metadata.hasError] — contains an error
   * @param {boolean} [metadata.hasPageRead] — contains page content
   * @param {boolean} [metadata.hasElements] — contains element discovery
   * @param {number} [metadata.importance] — override importance score
   */
  function addMessage(role, content, metadata = {}) {
    const importance = metadata.importance || scoreImportance(metadata);

    messages.push({
      role,
      content,
      metadata: {
        ...metadata,
        importance,
        timestamp: Date.now(),
        index: messages.length
      }
    });

    // Auto-prune if over limits
    if (messages.length > config.maxMessages || estimateTokens() > config.maxTokens) {
      prune();
    }
  }

  // ── Importance scoring ───────────────────────────────

  /**
   * Score a message's importance based on metadata.
   */
  function scoreImportance(meta) {
    if (meta.hasError) return IMPORTANCE.CRITICAL;
    if (meta.hasPageRead) return IMPORTANCE.HIGH;
    if (meta.hasElements) return IMPORTANCE.HIGH;
    if (meta.actionType === 'done' || meta.actionType === 'fail') return IMPORTANCE.CRITICAL;
    if (meta.actionType === 'click' || meta.actionType === 'click_type') return IMPORTANCE.MEDIUM;
    if (meta.actionType === 'type' || meta.actionType === 'key') return IMPORTANCE.MEDIUM;
    if (meta.actionType === 'focus') return IMPORTANCE.LOW;
    if (meta.actionType === 'read') return IMPORTANCE.HIGH;
    return IMPORTANCE.MEDIUM;
  }

  // ── Pruning ──────────────────────────────────────────

  /**
   * Prune old messages — summarize and remove.
   */
  function prune() {
    const keepCount = config.keepRecent * 2; // exchanges = 2 messages each

    if (messages.length <= keepCount) return;

    // Split into old and recent
    const oldMessages = messages.splice(0, messages.length - keepCount);
    totalPruned += oldMessages.length;

    // Remove screenshots from old messages (expensive)
    stripScreenshots(oldMessages);

    // Generate summary of old messages
    const summary = summarize(oldMessages);
    if (summary) {
      summaries.push(summary);
    }

    // Also strip screenshots from all but the last N recent messages
    let screenshotCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (hasScreenshot(messages[i])) {
        screenshotCount++;
        if (screenshotCount > config.maxScreenshots) {
          stripScreenshot(messages[i]);
        }
      }
    }
  }

  /**
   * Check if a message contains a screenshot.
   */
  function hasScreenshot(msg) {
    if (Array.isArray(msg.content)) {
      return msg.content.some(c => c.type === 'image_url');
    }
    return false;
  }

  /**
   * Remove screenshots from a single message.
   */
  function stripScreenshot(msg) {
    if (Array.isArray(msg.content)) {
      msg.content = msg.content.filter(c => c.type !== 'image_url');
      if (msg.content.length === 1 && msg.content[0].type === 'text') {
        msg.content = msg.content[0].text;
      }
    }
  }

  /**
   * Remove all screenshots from an array of messages.
   */
  function stripScreenshots(msgs) {
    for (const msg of msgs) {
      stripScreenshot(msg);
    }
  }

  // ── Summarization ────────────────────────────────────

  /**
   * Summarize a batch of old messages into a compact text.
   *
   * @param {Array} oldMessages
   * @returns {string}
   */
  function summarize(oldMessages) {
    const steps = [];
    let currentStep = null;

    for (const msg of oldMessages) {
      const meta = msg.metadata || {};

      if (meta.step && meta.step !== currentStep) {
        currentStep = meta.step;
      }

      // Extract key information from message content
      const text = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content)
          ? msg.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
          : '');

      if (!text) continue;

      // Extract action descriptions
      if (meta.actionType) {
        const shortDesc = extractActionDescription(text, meta.actionType);
        if (shortDesc) steps.push(`Step ${meta.step || '?'}: ${shortDesc}`);
      }

      // Keep error messages
      if (meta.hasError && text.length < 200) {
        steps.push(`ERROR: ${text.substring(0, 150)}`);
      }

      // Keep element discoveries
      if (meta.hasElements) {
        const count = (text.match(/\[\d+\]/g) || []).length;
        if (count > 0) steps.push(`Found ${count} elements on screen`);
      }

      // Keep page read summaries
      if (meta.hasPageRead) {
        const titleMatch = text.match(/PAGE CONTENT from "(.+?)"/);
        if (titleMatch) steps.push(`Read page: "${titleMatch[1]}"`);
      }
    }

    if (steps.length === 0) return null;

    return `PREVIOUS STEPS (summarized):\n${steps.join('\n')}`;
  }

  /**
   * Extract a short description of an action from message text.
   */
  function extractActionDescription(text, actionType) {
    switch (actionType) {
      case 'focus': {
        const m = text.match(/Focus(?:ed)?\s+(\w+)/i);
        return m ? `Focused ${m[1]}` : 'Focused app';
      }
      case 'click': return 'Clicked element';
      case 'click_type': {
        const m = text.match(/type[d]?\s+"?(.{1,30})/i);
        return m ? `Typed "${m[1]}"` : 'Clicked and typed';
      }
      case 'key': {
        const m = text.match(/(?:key|press)\s+(\w+)/i);
        return m ? `Pressed ${m[1]}` : 'Pressed key';
      }
      case 'read': return 'Read page content';
      case 'navigate': return 'Navigated to new page';
      case 'scroll': return 'Scrolled page';
      default: return actionType;
    }
  }

  // ── Token estimation ─────────────────────────────────

  /**
   * Estimate total tokens in current history.
   * ~4 chars per token for text, ~1000 tokens per screenshot.
   *
   * @returns {number}
   */
  function estimateTokens() {
    let tokens = 0;

    // Summaries
    for (const s of summaries) {
      tokens += Math.ceil(s.length / 4);
    }

    // Messages
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        tokens += Math.ceil(msg.content.length / 4);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') tokens += Math.ceil((part.text || '').length / 4);
          if (part.type === 'image_url') tokens += 1000;
        }
      }
    }

    return tokens;
  }

  // ── Get history for model ────────────────────────────

  /**
   * Get the pruned, optimized message history ready for the model.
   *
   * @returns {Array<{role: string, content: *}>}
   */
  function getHistory() {
    const result = [];

    // Add summaries as a system-style context block
    if (summaries.length > 0) {
      result.push({
        role: 'user',
        content: summaries.join('\n\n')
      });
    }

    // Add current messages
    for (const msg of messages) {
      result.push({ role: msg.role, content: msg.content });
    }

    return result;
  }

  /**
   * Set importance of a specific message.
   *
   * @param {number} index — message index
   * @param {number} importance — IMPORTANCE level
   */
  function setImportance(index, importance) {
    const msg = messages.find(m => m.metadata.index === index);
    if (msg) msg.metadata.importance = importance;
  }

  /**
   * Get statistics.
   */
  function getStats() {
    return {
      currentMessages: messages.length,
      totalPruned,
      summaryCount: summaries.length,
      estimatedTokens: estimateTokens(),
      screenshotCount: messages.filter(m => hasScreenshot(m)).length
    };
  }

  /**
   * Clear all history.
   */
  function clear() {
    messages.length = 0;
    summaries.length = 0;
    totalPruned = 0;
  }

  return {
    addMessage,
    getHistory,
    estimateTokens,
    setImportance,
    getStats,
    clear,
    prune
  };
}

module.exports = { create, IMPORTANCE };
