import { knowledgeError } from './knowledge-manager.js';

function normalize(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function searchDocuments(documents, query, { limit = 5, maxChars = 6000 } = {}) {
  if (typeof query !== 'string' || query.length > 4096) throw knowledgeError('Consulta deve ser texto com até 4096 caracteres.');
  const terms = [...new Set(normalize(query).match(/[\p{L}\p{N}_-]+/gu) ?? [])];
  if (!terms.length) throw knowledgeError('Informe ao menos uma palavra para buscar.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw knowledgeError('Limit deve ser um inteiro entre 1 e 20.');
  const results = [];
  for (const doc of documents) {
    const lines = doc.text.split('\n');
    // Bounded windows preserve original line numbers, including very long lines.
    const windows = [];
    let text = '';
    let lineNumber = 1;
    for (let i = 0; i < lines.length; i++) {
      if (text && (text.length + lines[i].length + 1 > 1200 || i + 1 - lineNumber >= 10)) {
        windows.push({ text, line: lineNumber });
        text = '';
      }
      if (lines[i].length > 1200) {
        for (let offset = 0; offset < lines[i].length; offset += 1100) {
          windows.push({ text: lines[i].slice(offset, offset + 1200), line: i + 1 });
        }
        continue;
      }
      if (!text) lineNumber = i + 1;
      text += (text ? '\n' : '') + lines[i];
    }
    if (text) windows.push({ text, line: lineNumber });
    for (const window of windows) {
      const normalized = normalize(window.text);
      const score = terms.filter((term) => normalized.includes(term)).length;
      if (score) results.push({ id: doc.id, title: doc.title, ...window, score });
    }
  }
  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id) || a.line - b.line);
  const selected = [];
  let chars = 0;
  for (const result of results) {
    if (selected.length >= limit) break;
    if (chars + result.text.length > maxChars) break;
    selected.push(result);
    chars += result.text.length;
  }
  return selected;
}