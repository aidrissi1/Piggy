/**
 * Piggy — OCR Module
 * Uses macOS Vision framework to extract text from screenshots.
 * Handles non-browser apps where DOM extraction doesn't work.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SWIFT_PATH = path.join(os.tmpdir(), 'piggy-ocr.swift');

// LRU cache: hash → { elements, ts }
const cache = new Map();
const CACHE_MAX = 32;
const CACHE_TTL = 60000; // 60s

/**
 * The Swift script that calls Vision framework's VNRecognizeTextRequest.
 * Outputs: IMAGE|width|height on first line, then text|x|y|w|h|confidence per observation.
 * Coordinates are normalized (0-1), bottom-left origin (Vision framework convention).
 */
const SWIFT_SCRIPT = `
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: swift piggy-ocr.swift <image-path>\\n", stderr)
    exit(1)
}

let imagePath = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: imagePath) else {
    fputs("Cannot load image: \\(imagePath)\\n", stderr)
    exit(1)
}

guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fputs("Cannot get CGImage\\n", stderr)
    exit(1)
}

let width = cgImage.width
let height = cgImage.height
print("IMAGE|\\(width)|\\(height)")

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try? handler.perform([request])

guard let observations = request.results else { exit(0) }

for obs in observations {
    guard let candidate = obs.topCandidates(1).first else { continue }
    let box = obs.boundingBox
    let text = candidate.string.replacingOccurrences(of: "|", with: " ")
        .replacingOccurrences(of: "\\n", with: " ")
        .replacingOccurrences(of: "\\r", with: " ")
    let conf = candidate.confidence
    print("\\(text)|\\(box.origin.x)|\\(box.origin.y)|\\(box.size.width)|\\(box.size.height)|\\(conf)")
}
`;

/**
 * Ensure the Swift script is written to disk.
 */
function ensureSwiftScript() {
  if (!fs.existsSync(SWIFT_PATH)) {
    fs.writeFileSync(SWIFT_PATH, SWIFT_SCRIPT);
  }
}

/**
 * Compute SHA-256 hash of file for caching.
 */
function fileHash(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
}

/**
 * Classify an OCR observation as button, link, or text based on heuristics.
 *
 * @param {string} text — the recognized text
 * @param {number} w — width ratio (0-1)
 * @param {number} h — height ratio (0-1)
 * @returns {{tag: string, role: string}}
 */
function classifyElement(text, w, h) {
  const t = text.trim();
  const aspect = w / (h || 0.001);

  // URL patterns → link
  if (/^https?:\/\//.test(t) || /\.(com|org|net|io|dev|ai)\b/.test(t)) {
    return { tag: 'a', role: 'link' };
  }

  // Common button labels
  const buttonPatterns = /^(ok|cancel|submit|search|sign in|sign up|log in|log out|continue|next|back|close|open|save|delete|send|apply|confirm|done|go|start|stop|yes|no|accept|decline|allow|deny|retry|skip|upload|download|share|edit|copy|paste|cut|undo|redo|refresh|reload|settings|preferences|options|menu|help|about|more|less|show|hide|view|filter|sort|clear|reset|add|remove|create|update|new|install|uninstall)$/i;
  if (buttonPatterns.test(t)) {
    return { tag: 'button', role: 'button' };
  }

  // Short text with wide aspect ratio → likely button
  if (t.length <= 20 && aspect > 2 && h < 0.06) {
    return { tag: 'button', role: 'button' };
  }

  // Capitalized short text → likely button or label
  if (t.length <= 15 && /^[A-Z]/.test(t) && !/\s{2,}/.test(t)) {
    return { tag: 'button', role: 'button' };
  }

  return { tag: 'span', role: 'text' };
}

/**
 * Run OCR on a screenshot file.
 *
 * @param {string} screenshotPath — path to PNG/JPEG file
 * @param {number} screenWidth — logical screen width
 * @param {number} screenHeight — logical screen height
 * @returns {Array<{id: number, source: string, tag: string, role: string, name: string, x: number, y: number, w: number, h: number, cx: number, cy: number, confidence: number}>}
 */
function recognize(screenshotPath, screenWidth, screenHeight) {
  ensureSwiftScript();

  // Check cache
  const hash = fileHash(screenshotPath);
  const cached = cache.get(hash);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.elements;
  }

  let raw;
  try {
    raw = execSync(`/usr/bin/swift "${SWIFT_PATH}" "${screenshotPath}"`, {
      encoding: 'utf8',
      timeout: 15000
    }).trim();
  } catch (err) {
    console.warn('[Piggy OCR] Swift execution failed:', err.message?.substring(0, 100));
    return [];
  }

  if (!raw) return [];

  const lines = raw.split('\n').filter(Boolean);
  if (lines.length < 1) return [];

  // First line: IMAGE|pixelWidth|pixelHeight
  let imgW = screenWidth, imgH = screenHeight;
  if (lines[0].startsWith('IMAGE|')) {
    const parts = lines[0].split('|');
    imgW = parseInt(parts[1]) || screenWidth;
    imgH = parseInt(parts[2]) || screenHeight;
  }

  // Scale factor (retina)
  const scaleX = screenWidth / imgW;
  const scaleY = screenHeight / imgH;

  const elements = [];
  let id = 1;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('|');
    if (parts.length < 6) continue;

    const [text, nx, ny, nw, nh, nconf] = parts;
    const normX = parseFloat(nx);
    const normY = parseFloat(ny);
    const normW = parseFloat(nw);
    const normH = parseFloat(nh);
    const confidence = parseFloat(nconf);

    if (isNaN(normX) || isNaN(normY)) continue;
    if (confidence < 0.3) continue; // skip low confidence

    // Convert from Vision's bottom-left origin to top-left
    const topLeftY = 1.0 - normY - normH;

    // Convert to screen pixels
    const x = Math.round(normX * imgW * scaleX);
    const y = Math.round(topLeftY * imgH * scaleY);
    const w = Math.round(normW * imgW * scaleX);
    const h = Math.round(normH * imgH * scaleY);

    const { tag, role } = classifyElement(text.trim(), normW, normH);

    elements.push({
      id,
      source: 'ocr',
      tag,
      role,
      name: text.trim(),
      x, y, w, h,
      cx: x + Math.round(w / 2),
      cy: y + Math.round(h / 2),
      confidence: Math.round(confidence * 100)
    });
    id++;
  }

  // Cache results
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(hash, { elements, ts: Date.now() });

  return elements;
}

/**
 * Run OCR from a base64-encoded image.
 *
 * @param {string} base64 — base64 PNG/JPEG data
 * @param {number} screenWidth — logical screen width
 * @param {number} screenHeight — logical screen height
 * @returns {Array} — same as recognize()
 */
function recognizeFromBase64(base64, screenWidth, screenHeight) {
  const tmpFile = path.join(os.tmpdir(), `piggy-ocr-${Date.now()}.png`);
  try {
    const buffer = Buffer.from(base64, 'base64');
    fs.writeFileSync(tmpFile, buffer);
    return recognize(tmpFile, screenWidth, screenHeight);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Build a numbered element map string for the AI prompt.
 *
 * @param {Array} elements — from recognize()
 * @returns {string}
 */
function buildMap(elements) {
  if (!elements || elements.length === 0) return 'OCR: No text found on screen.';
  const lines = elements.map(el => {
    const label = el.name ? `"${el.name}"` : `(${el.role})`;
    return `  [${el.id}] ${el.role} — ${label} at (${el.cx}, ${el.cy}) [${el.confidence}%]`;
  });
  return `OCR ELEMENTS (text found on screen):\n${lines.join('\n')}`;
}

/**
 * Clear the OCR cache.
 */
function clearCache() {
  cache.clear();
}

module.exports = { recognize, recognizeFromBase64, buildMap, clearCache };
