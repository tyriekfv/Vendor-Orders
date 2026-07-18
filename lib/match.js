'use strict';
// Fuzzy item matching and quick-order text parsing. Plain code, no AI.

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function singular(word) {
  if (word.length > 3 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 2 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 1 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function tokens(s) {
  return normalize(s).split(' ').filter(Boolean).map(singular);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

// Score how well `query` matches a single candidate name. 0..100.
function scoreName(query, name) {
  const q = normalize(query), c = normalize(name);
  if (!q || !c) return 0;
  if (q === c) return 100;
  const qt = tokens(query), ct = tokens(name);
  if (qt.join(' ') === ct.join(' ')) return 98;
  let score = 0;
  if (c.startsWith(q) || q.startsWith(c)) score = Math.max(score, 88);
  if (c.includes(q) || q.includes(c)) score = Math.max(score, 80);
  // token overlap (order-independent): "dutchman flying" still matches
  const cset = new Set(ct);
  const hit = qt.filter((t) => cset.has(t)).length;
  if (hit) {
    const overlap = hit / Math.max(qt.length, ct.length);
    score = Math.max(score, Math.round(45 + 45 * overlap));
  }
  // typo tolerance on the whole string
  const dist = levenshtein(q, c);
  const ratio = 1 - dist / Math.max(q.length, c.length);
  if (ratio > 0.6) score = Math.max(score, Math.round(ratio * 82));
  return score;
}

// Match a query string against a vendor's items (name + aliases).
// Returns { best, score, candidates: [{item, score}] }
function matchItem(query, items) {
  const scored = items
    .map((item) => {
      const names = [item.name, ...String(item.aliases || '').split(',')].filter((s) => s && s.trim());
      const score = Math.max(...names.map((n) => scoreName(query, n)));
      return { item, score };
    })
    .filter((r) => r.score >= 55)
    .sort((a, b) => b.score - a.score);
  return {
    best: scored.length ? scored[0].item : null,
    score: scored.length ? scored[0].score : 0,
    candidates: scored.slice(0, 5),
  };
}

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, dozen: 12,
};

// Parse free text like "2 flying dutchman and a fry, 3x animal fries"
// into [{qty, query}].
function parseQuickOrder(text) {
  const parts = String(text || '')
    .split(/,|;|\n|\band\b|&|\+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const lines = [];
  for (const part of parts) {
    let qty = 1;
    let rest = part;
    let m;
    if ((m = rest.match(/^(\d+)\s*[xX]\s+(.+)$/) || rest.match(/^(\d+)\s+(.+)$/))) {
      qty = parseInt(m[1], 10);
      rest = m[2];
    } else if ((m = rest.match(/^([a-zA-Z]+)\s+(.+)$/)) && NUMBER_WORDS[m[1].toLowerCase()] != null) {
      qty = NUMBER_WORDS[m[1].toLowerCase()];
      rest = m[2];
    } else if ((m = rest.match(/^(.+?)\s*[xX]\s*(\d+)$/))) {
      qty = parseInt(m[2], 10);
      rest = m[1];
    }
    rest = rest.replace(/^(of|the)\s+/i, '').trim();
    if (rest) lines.push({ qty: Math.max(1, qty || 1), query: rest });
  }
  return lines;
}

module.exports = { matchItem, parseQuickOrder, scoreName };
