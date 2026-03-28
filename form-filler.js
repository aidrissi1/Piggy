/**
 * Piggy — Form Filler
 * Intelligently fills multi-field web forms.
 * Detects form fields, matches them to provided data, and fills them in order.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_SCRIPT = path.join(os.tmpdir(), 'piggy-form.scpt');

// ── Form detection ───────────────────────────────────────

/**
 * Detect all form fields on the current Safari page.
 * Returns fields with their types, labels, positions, and current values.
 *
 * @returns {Promise<{success: boolean, fields: Array<{id: number, tag: string, type: string, name: string, label: string, placeholder: string, value: string, required: boolean, x: number, y: number, w: number, h: number, cx: number, cy: number}>}>}
 */
function detectFields() {
  const script = `tell application "Safari"
  if (count of windows) = 0 then return ""
  set winBounds to bounds of window 1
  set winX to item 1 of winBounds
  set winY to item 2 of winBounds
  set formData to do JavaScript "
    (function() {
      var fields = [];
      var els = document.querySelectorAll('input, textarea, select');
      var id = 1;
      for (var i = 0; i < els.length && i < 50; i++) {
        var el = els[i];
        var rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) continue;
        if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue;

        // Find label
        var label = '';
        if (el.id) {
          var labelEl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']');
          if (labelEl) label = labelEl.textContent.trim();
        }
        if (!label && el.closest('label')) {
          label = el.closest('label').textContent.trim();
        }
        if (!label) label = el.getAttribute('aria-label') || el.placeholder || el.name || '';

        fields.push({
          id: id++,
          tag: el.tagName.toLowerCase(),
          type: el.type || 'text',
          name: el.name || '',
          label: label.substring(0, 60),
          placeholder: (el.placeholder || '').substring(0, 60),
          value: (el.value || '').substring(0, 60),
          required: el.required || false,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        });
      }
      return JSON.stringify(fields);
    })()
  " in current tab of window 1
  return (winX as text) & \"|\" & (winY as text) & \"|SPLIT|\" & formData
end tell`;

  fs.writeFileSync(TMP_SCRIPT, script);

  return new Promise((resolve) => {
    exec(`osascript "${TMP_SCRIPT}"`, { encoding: 'utf8', timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve({ success: false, fields: [], error: err.message?.substring(0, 100) });
        return;
      }

      const raw = (stdout || '').trim();
      const parts = raw.split('|SPLIT|');
      if (parts.length < 2) { resolve({ success: false, fields: [] }); return; }

      const [coords] = parts[0].split('|');
      const winX = parseInt(coords) || 0;
      const winY = parseInt(parts[0].split('|')[1]) || 0;
      const toolbarOffset = 75;

      let fields;
      try { fields = JSON.parse(parts[1]); } catch { resolve({ success: false, fields: [] }); return; }

      // Convert to screen coordinates
      for (const f of fields) {
        f.x += winX;
        f.y += winY + toolbarOffset;
        f.cx = f.x + Math.round(f.w / 2);
        f.cy = f.y + Math.round(f.h / 2);
      }

      resolve({ success: true, fields });
    });
  });
}

// ── Field matching ───────────────────────────────────────

/**
 * Common field name patterns for auto-matching user data to form fields.
 */
const FIELD_PATTERNS = {
  email:     /email|e-mail|mail/i,
  password:  /password|passwd|pass/i,
  firstName: /first.?name|given.?name|fname|prenom/i,
  lastName:  /last.?name|family.?name|surname|lname|nom/i,
  fullName:  /full.?name|name|your.?name/i,
  phone:     /phone|tel|mobile|cell/i,
  address:   /address|street|addr/i,
  city:      /city|town|ville/i,
  state:     /state|province|region/i,
  zip:       /zip|postal|post.?code/i,
  country:   /country|nation|pays/i,
  company:   /company|organization|org|entreprise/i,
  website:   /website|url|site|homepage/i,
  username:  /username|user.?name|login|handle/i,
  message:   /message|comment|note|description|text/i,
  search:    /search|query|find|q\b/i
};

/**
 * Match form fields to provided data values.
 *
 * @param {Array} fields — from detectFields()
 * @param {object} data — { email: "x@y.com", firstName: "John", ... }
 * @returns {Array<{field: object, value: string, confidence: number}>}
 */
function matchFields(fields, data) {
  const matches = [];

  for (const field of fields) {
    const searchText = `${field.label} ${field.name} ${field.placeholder} ${field.type}`.toLowerCase();
    let bestMatch = null;
    let bestConfidence = 0;

    for (const [dataKey, pattern] of Object.entries(FIELD_PATTERNS)) {
      if (data[dataKey] && pattern.test(searchText)) {
        const confidence = field.label && pattern.test(field.label) ? 0.9 : 0.7;
        if (confidence > bestConfidence) {
          bestMatch = dataKey;
          bestConfidence = confidence;
        }
      }
    }

    // Type-based matching as fallback
    if (!bestMatch && field.type === 'email' && data.email) {
      bestMatch = 'email';
      bestConfidence = 0.95;
    }
    if (!bestMatch && field.type === 'password' && data.password) {
      bestMatch = 'password';
      bestConfidence = 0.95;
    }
    if (!bestMatch && field.type === 'tel' && data.phone) {
      bestMatch = 'phone';
      bestConfidence = 0.95;
    }

    if (bestMatch) {
      matches.push({
        field,
        dataKey: bestMatch,
        value: data[bestMatch],
        confidence: bestConfidence
      });
    }
  }

  return matches;
}

/**
 * Generate a fill plan — ordered list of actions to fill the form.
 *
 * @param {Array} matches — from matchFields()
 * @returns {Array<{action: string, x: number, y: number, text: string, fieldLabel: string, confidence: number}>}
 */
function generateFillPlan(matches) {
  // Sort by vertical position (top to bottom, natural form order)
  const sorted = [...matches].sort((a, b) => a.field.cy - b.field.cy);

  return sorted.map(m => ({
    action: 'click_type',
    x: m.field.cx,
    y: m.field.cy,
    text: m.value,
    fieldLabel: m.field.label || m.field.name || m.field.placeholder,
    dataKey: m.dataKey,
    confidence: m.confidence
  }));
}

/**
 * Build a form summary for the AI prompt.
 *
 * @param {Array} fields — from detectFields()
 * @returns {string}
 */
function buildFormMap(fields) {
  if (!fields || fields.length === 0) return 'No form fields detected.';

  const lines = fields.map(f => {
    const label = f.label || f.placeholder || f.name || '(unlabeled)';
    const value = f.value ? ` [current: "${f.value}"]` : '';
    const req = f.required ? ' *required' : '';
    return `  [${f.id}] ${f.type} — "${label}" at (${f.cx}, ${f.cy})${value}${req}`;
  });

  return `FORM FIELDS:\n${lines.join('\n')}`;
}

module.exports = {
  detectFields,
  matchFields,
  generateFillPlan,
  buildFormMap,
  FIELD_PATTERNS
};
