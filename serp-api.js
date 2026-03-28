/**
 * Piggy — SerpApi Web Search
 * Searches the web via SerpApi and returns structured results.
 * Uses the REST API directly — no npm dependency needed.
 *
 * Set SERPAPI_KEY in your .env file.
 *
 * @author Idrissi
 * @license Apache-2.0
 */

'use strict';

const SERPAPI_BASE = 'https://serpapi.com/search.json';

/**
 * Search the web via SerpApi (Google engine by default).
 *
 * @param {string} query — search query
 * @param {object} [opts]
 * @param {string} [opts.engine='google'] — search engine
 * @param {number} [opts.num=5] — number of results
 * @param {string} [opts.gl] — country code (e.g. 'us')
 * @param {string} [opts.hl] — language code (e.g. 'en')
 * @returns {Promise<{success: boolean, query: string, results: Array<{title: string, link: string, snippet: string, position: number}>, answerBox?: object, knowledgeGraph?: object, error?: string}>}
 */
async function search(query, opts = {}) {
  const apiKey = process.env.SERPAPI_KEY || process.env.SERP_API_KEY;
  if (!apiKey) {
    return { success: false, query, results: [], error: 'No SERPAPI_KEY found in environment' };
  }

  const params = new URLSearchParams({
    q: query,
    api_key: apiKey,
    engine: opts.engine || 'google',
    num: String(opts.num || 5),
  });
  if (opts.gl) params.set('gl', opts.gl);
  if (opts.hl) params.set('hl', opts.hl);

  try {
    const res = await fetch(`${SERPAPI_BASE}?${params.toString()}`);
    if (!res.ok) {
      const text = await res.text();
      return { success: false, query, results: [], error: `SerpApi ${res.status}: ${text.substring(0, 200)}` };
    }

    const data = await res.json();

    // Extract organic results
    const results = (data.organic_results || []).slice(0, opts.num || 5).map((r, i) => ({
      title: r.title || '',
      link: r.link || '',
      snippet: r.snippet || '',
      position: i + 1
    }));

    // Extract answer box if present
    let answerBox = null;
    if (data.answer_box) {
      answerBox = {
        type: data.answer_box.type || 'unknown',
        title: data.answer_box.title || '',
        answer: data.answer_box.answer || data.answer_box.snippet || '',
        link: data.answer_box.link || ''
      };
    }

    // Extract knowledge graph if present
    let knowledgeGraph = null;
    if (data.knowledge_graph) {
      knowledgeGraph = {
        title: data.knowledge_graph.title || '',
        type: data.knowledge_graph.type || '',
        description: data.knowledge_graph.description || '',
        source: data.knowledge_graph.source?.link || ''
      };
    }

    return { success: true, query, results, answerBox, knowledgeGraph };
  } catch (err) {
    return { success: false, query, results: [], error: err.message };
  }
}

/**
 * Format search results into a text block for the AI prompt.
 *
 * @param {object} searchResult — from search()
 * @returns {string}
 */
function formatForPrompt(searchResult) {
  if (!searchResult.success) {
    return `WEB SEARCH FAILED: ${searchResult.error}`;
  }

  const parts = [`WEB SEARCH RESULTS for "${searchResult.query}":`];

  if (searchResult.answerBox) {
    parts.push(`\nDIRECT ANSWER: ${searchResult.answerBox.answer}`);
    if (searchResult.answerBox.link) parts.push(`  Source: ${searchResult.answerBox.link}`);
  }

  if (searchResult.knowledgeGraph) {
    const kg = searchResult.knowledgeGraph;
    parts.push(`\nKNOWLEDGE: ${kg.title}${kg.type ? ` (${kg.type})` : ''}`);
    if (kg.description) parts.push(`  ${kg.description}`);
  }

  if (searchResult.results.length > 0) {
    parts.push('\nRESULTS:');
    for (const r of searchResult.results) {
      parts.push(`  ${r.position}. ${r.title}`);
      parts.push(`     ${r.link}`);
      if (r.snippet) parts.push(`     ${r.snippet}`);
    }
  } else {
    parts.push('\nNo results found.');
  }

  return parts.join('\n');
}

module.exports = { search, formatForPrompt };
