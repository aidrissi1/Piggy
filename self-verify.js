/**
 * Piggy — Self-Verification Module
 * After completing a task, Piggy independently verifies the result.
 * Checks that the actual screen state matches expected outcomes.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

// ── Verification strategies ──────────────────────────────

/**
 * @typedef {object} VerificationResult
 * @property {boolean} verified — true if the task appears complete
 * @property {number} confidence — 0.0-1.0 confidence in the verification
 * @property {string} reason — explanation
 * @property {string[]} checks — individual checks that were performed
 */

/**
 * Verify a navigation task — did we arrive at the expected page?
 *
 * @param {object} ctx
 * @param {string} ctx.expectedURL — URL we were navigating to
 * @param {Array} ctx.elements — current screen elements
 * @param {string} [ctx.pageTitle] — current page title if available
 * @returns {VerificationResult}
 */
function verifyNavigation(ctx) {
  const checks = [];
  let score = 0;

  const { expectedURL, elements = [], pageTitle = '' } = ctx;
  if (!expectedURL) return { verified: false, confidence: 0, reason: 'No expected URL', checks: [] };

  // Extract domain from expected URL
  const domain = expectedURL.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();

  // Check 1: Do elements suggest we're on the right page?
  const elementTexts = elements.map(e => (e.name || '').toLowerCase()).join(' ');
  if (elementTexts.includes(domain.split('.')[0])) {
    checks.push(`✓ Elements contain "${domain.split('.')[0]}"`);
    score += 0.3;
  } else {
    checks.push(`✗ Elements don't mention "${domain.split('.')[0]}"`);
  }

  // Check 2: Are there interactive elements? (page loaded, not blank)
  if (elements.length > 5) {
    checks.push(`✓ Page has ${elements.length} interactive elements`);
    score += 0.3;
  } else if (elements.length > 0) {
    checks.push(`~ Page has only ${elements.length} elements (might still be loading)`);
    score += 0.1;
  } else {
    checks.push('✗ No elements found — page may not have loaded');
  }

  // Check 3: Page title contains domain or expected content
  if (pageTitle && pageTitle.toLowerCase().includes(domain.split('.')[0])) {
    checks.push(`✓ Page title contains "${domain.split('.')[0]}"`);
    score += 0.2;
  }

  // Check 4: No error indicators in elements
  const errorIndicators = elements.filter(e =>
    /error|not found|404|couldn't|can't connect|no internet/i.test(e.name || '')
  );
  if (errorIndicators.length > 0) {
    checks.push(`✗ Error indicators found: ${errorIndicators.map(e => e.name).join(', ')}`);
    score -= 0.3;
  } else {
    checks.push('✓ No error indicators');
    score += 0.2;
  }

  return {
    verified: score >= 0.5,
    confidence: Math.max(0, Math.min(1, score)),
    reason: score >= 0.5 ? `Navigation to ${domain} appears successful` : `Cannot confirm navigation to ${domain}`,
    checks
  };
}

/**
 * Verify a search task — did search results appear?
 *
 * @param {object} ctx
 * @param {string} ctx.query — the search query
 * @param {Array} ctx.elements — current screen elements
 * @param {object} [ctx.screenDiff] — screen diff from before/after
 * @returns {VerificationResult}
 */
function verifySearch(ctx) {
  const checks = [];
  let score = 0;

  const { query, elements = [], screenDiff = null } = ctx;
  if (!query) return { verified: false, confidence: 0, reason: 'No query to verify', checks: [] };

  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  // Check 1: Screen changed significantly (search results loaded)
  if (screenDiff && screenDiff.changed && screenDiff.changePercent > 20) {
    checks.push(`✓ Screen changed ${screenDiff.changePercent}% — results likely loaded`);
    score += 0.3;
  } else if (screenDiff && !screenDiff.changed) {
    checks.push('✗ Screen unchanged — search may not have executed');
  }

  // Check 2: More elements appeared (search results = lots of links)
  if (elements.length > 15) {
    checks.push(`✓ ${elements.length} elements on screen — looks like search results`);
    score += 0.2;
  }

  // Check 3: Links in results contain query words
  const links = elements.filter(e => e.role === 'link' && e.name);
  const relevantLinks = links.filter(e => {
    const name = e.name.toLowerCase();
    return queryWords.some(w => name.includes(w));
  });
  if (relevantLinks.length > 0) {
    checks.push(`✓ Found ${relevantLinks.length} results matching query words`);
    score += 0.3;
  } else if (links.length > 5) {
    checks.push('~ Links present but none match query words');
    score += 0.1;
  }

  // Check 4: Search input still shows query
  const searchInputs = elements.filter(e =>
    e.tag === 'textarea' || e.tag === 'input' || e.role === 'search'
  );
  const queryInInput = searchInputs.some(e =>
    queryWords.some(w => (e.name || '').toLowerCase().includes(w))
  );
  if (queryInInput) {
    checks.push('✓ Query visible in search input');
    score += 0.2;
  }

  return {
    verified: score >= 0.5,
    confidence: Math.max(0, Math.min(1, score)),
    reason: score >= 0.5 ? `Search for "${query}" appears successful` : `Cannot confirm search results for "${query}"`,
    checks
  };
}

/**
 * Verify a click task — did the click have an effect?
 *
 * @param {object} ctx
 * @param {string} ctx.target — what was clicked
 * @param {object} ctx.screenDiff — before/after diff
 * @param {Array} ctx.elementsBefore — elements before click
 * @param {Array} ctx.elementsAfter — elements after click
 * @returns {VerificationResult}
 */
function verifyClick(ctx) {
  const checks = [];
  let score = 0;

  const { target, screenDiff = null, elementsBefore = [], elementsAfter = [] } = ctx;

  // Check 1: Screen changed
  if (screenDiff && screenDiff.changed) {
    checks.push(`✓ Screen changed after click (${screenDiff.changePercent}%)`);
    score += 0.4;
  } else {
    checks.push('✗ Screen unchanged after click — may not have worked');
  }

  // Check 2: Element list changed
  if (elementsAfter.length !== elementsBefore.length) {
    checks.push(`✓ Element count changed: ${elementsBefore.length} → ${elementsAfter.length}`);
    score += 0.3;
  }

  // Check 3: Target element may have been consumed (removed from list)
  if (target) {
    const targetLower = target.toLowerCase();
    const wasThere = elementsBefore.some(e => (e.name || '').toLowerCase().includes(targetLower));
    const stillThere = elementsAfter.some(e => (e.name || '').toLowerCase().includes(targetLower));
    if (wasThere && !stillThere) {
      checks.push(`✓ Target "${target}" is no longer visible — click likely worked`);
      score += 0.3;
    }
  }

  return {
    verified: score >= 0.4,
    confidence: Math.max(0, Math.min(1, score)),
    reason: score >= 0.4 ? 'Click appears to have worked' : 'Cannot confirm click had effect',
    checks
  };
}

/**
 * Verify a type task — was text entered?
 *
 * @param {object} ctx
 * @param {string} ctx.text — the text that was typed
 * @param {Array} ctx.elements — current screen elements
 * @returns {VerificationResult}
 */
function verifyType(ctx) {
  const checks = [];
  let score = 0;

  const { text, elements = [] } = ctx;
  if (!text) return { verified: true, confidence: 0.5, reason: 'No text to verify', checks: [] };

  // Check: typed text appears in an input element
  const inputs = elements.filter(e =>
    ['textarea', 'input', 'text', 'search'].includes(e.tag) || e.role === 'textbox'
  );

  const textLower = text.toLowerCase();
  const found = inputs.some(e => (e.name || '').toLowerCase().includes(textLower.substring(0, 20)));

  if (found) {
    checks.push(`✓ Text "${text.substring(0, 30)}" found in input field`);
    score += 0.8;
  } else if (inputs.length > 0) {
    checks.push(`~ Input fields exist but text not visible (may be obscured)`);
    score += 0.3;
  } else {
    checks.push('✗ No input fields found');
  }

  return {
    verified: score >= 0.3,
    confidence: Math.max(0, Math.min(1, score)),
    reason: score >= 0.3 ? 'Text entry appears successful' : 'Cannot confirm text was entered',
    checks
  };
}

// ── Generic verification ─────────────────────────────────

/**
 * Auto-detect verification type from task and run appropriate checks.
 *
 * @param {string} taskType — 'navigate' | 'search' | 'click' | 'type' | 'general'
 * @param {object} ctx — context for verification
 * @returns {VerificationResult}
 */
function verify(taskType, ctx) {
  switch (taskType) {
    case 'navigate': return verifyNavigation(ctx);
    case 'search':   return verifySearch(ctx);
    case 'click':    return verifyClick(ctx);
    case 'type':     return verifyType(ctx);
    default:         return verifyGeneral(ctx);
  }
}

/**
 * General verification — just check that something changed and no errors.
 *
 * @param {object} ctx
 * @returns {VerificationResult}
 */
function verifyGeneral(ctx) {
  const { screenDiff = null, elements = [] } = ctx;
  const checks = [];
  let score = 0.5; // start neutral

  if (screenDiff && screenDiff.changed) {
    checks.push('✓ Screen state changed');
    score += 0.2;
  }

  if (elements.length > 0) {
    checks.push(`✓ ${elements.length} elements visible`);
    score += 0.1;
  }

  const errors = elements.filter(e => /error|fail|denied|blocked/i.test(e.name || ''));
  if (errors.length > 0) {
    checks.push(`✗ Possible errors: ${errors.map(e => e.name).join(', ')}`);
    score -= 0.3;
  }

  return {
    verified: score >= 0.5,
    confidence: Math.max(0, Math.min(1, score)),
    reason: score >= 0.5 ? 'Task appears to have completed' : 'Cannot confirm task completion',
    checks
  };
}

/**
 * Generate a verification prompt for the AI model to double-check.
 * Used when automated verification is uncertain (confidence < 0.6).
 *
 * @param {string} task — original task description
 * @param {VerificationResult} result — automated verification result
 * @returns {string}
 */
function generateVerificationPrompt(task, result) {
  return `VERIFICATION CHECK:
Task was: "${task}"
Automated checks:
${result.checks.join('\n')}
Confidence: ${Math.round(result.confidence * 100)}%

Look at the screenshot carefully. Is the task actually complete?
If yes: {"action":"done","reason":"verified — ${result.reason}"}
If no: describe what's wrong and what to do next.`;
}

module.exports = {
  verify,
  verifyNavigation,
  verifySearch,
  verifyClick,
  verifyType,
  verifyGeneral,
  generateVerificationPrompt
};
