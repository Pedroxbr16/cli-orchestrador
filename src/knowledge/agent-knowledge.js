import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  knowledgeError,
  knowledgeSettings,
  listDocuments,
  safePath,
  scopeDirectory,
} from './knowledge-manager.js';

const START = '<oraculo-knowledge>';
const END = '</oraculo-knowledge>';
const ENTRY_LIMIT = 4;
const CONTENT_LIMIT = 4000;

function allowedScopes(mode) {
  if (mode === 'both') return new Set(['project', 'global']);
  if (mode === 'project' || mode === 'global') return new Set([mode]);
  return new Set();
}

function cleanText(value, limit, field) {
  if (typeof value !== 'string') throw knowledgeError(field + ' deve ser texto.');
  const text = value.replace(/\r\n/g, '\n').trim();
  if (!text || text.length > limit || /[\0\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
    throw knowledgeError(field + ' inválido ou acima do limite.');
  }
  return text;
}

function redactSecrets(text) {
  return text.replace(
    /\b(api[_-]?key|token|password|secret|senha)\b\s*[:=]\s*([^\s,;]+)/gi,
    '$1=[REDACTED]',
  );
}

export function knowledgePrompt(mode) {
  const scopes = [...allowedScopes(mode)];
  if (!scopes.length) return '';
  return (
    'APRENDIZADO DURÁVEL:\n' +
    '- Quando descobrir uma regra, decisão, solução ou padrão reutilizável, proponha até 4 registros.\n' +
    '- Não registre logs transitórios, suposições, dados pessoais ou credenciais.\n' +
    `- Escopos permitidos: ${scopes.join(', ')}. Use project para este repositório e global para padrões reutilizáveis.\n` +
    '- Ao final da resposta, emita opcionalmente um bloco exato neste formato:\n' +
    START + '{"entries":[{"scope":"project","title":"Título curto","content":"Conhecimento verificável"}]}' + END + '\n'
  );
}

export function extractAgentKnowledge(output, { mode = 'disabled' } = {}) {
  const scopes = allowedScopes(mode);
  const entries = [];
  const errors = [];
  let markers = 0;
  const originalOutput = String(output ?? '');
  let cleanOutput = originalOutput.replace(
    /<oraculo-knowledge>([\s\S]*?)<\/oraculo-knowledge>/g,
    (_match, body) => {
      markers++;
      if (markers > 2) {
        errors.push('blocos de knowledge excedem o limite.');
        return '';
      }
      try {
        const payload = JSON.parse(body.trim());
        if (!payload || !Array.isArray(payload.entries)) {
          throw knowledgeError('bloco precisa conter entries.');
        }
        for (const candidate of payload.entries) {
          if (entries.length >= ENTRY_LIMIT) {
            errors.push('registros de knowledge excedem o limite de 4.');
            break;
          }
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            throw knowledgeError('registro de knowledge inválido.');
          }
          const keys = Object.keys(candidate);
          if (keys.some((key) => !['scope', 'title', 'content'].includes(key))) {
            throw knowledgeError('registro de knowledge contém campo desconhecido.');
          }
          const scope = candidate.scope;
          if (!scopes.has(scope)) {
            throw knowledgeError('scope de knowledge não autorizado: ' + String(scope));
          }
          entries.push({
            scope,
            title: redactSecrets(cleanText(candidate.title, 120, 'title')),
            content: redactSecrets(cleanText(candidate.content, CONTENT_LIMIT, 'content')),
          });
        }
      } catch (error) {
        errors.push(String(error.message).slice(0, 300));
      }
      return '';
    },
  );

  const incomplete = cleanOutput.includes(START) || cleanOutput.includes(END);
  if (incomplete) {
    errors.push('bloco de knowledge incompleto.');
    cleanOutput = cleanOutput.replace(/<\/?oraculo-knowledge>/g, '');
  }
  if (!markers && !incomplete) return { output: originalOutput, entries, errors };
  cleanOutput = cleanOutput.replace(/\n{3,}/g, '\n\n').trim();
  return { output: cleanOutput, entries, errors };
}

export function automaticKnowledgeDocuments(documents, agent) {
  const prefix = 'learned-' + String(agent).toLowerCase() + '-';
  return documents.filter(({ id }) => id.split('/').at(-1)?.startsWith(prefix));
}

export async function persistAgentKnowledge(entries, {
  cwd = process.cwd(),
  agent,
} = {}) {
  if (!Array.isArray(entries) || !entries.length) return [];
  if (typeof agent !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(agent)) {
    throw knowledgeError('agent inválido para gravar knowledge.');
  }
  const config = await knowledgeSettings(cwd, true);
  const existing = await listDocuments({ cwd });
  let totalBytes = existing.reduce((total, document) => total + Buffer.byteLength(document.text), 0);
  const ids = [];
  for (const [index, entry] of entries.slice(0, ENTRY_LIMIT).entries()) {
    const directory = scopeDirectory(entry.scope, config, cwd);
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const suffix = randomBytes(4).toString('hex');
    const signature = '# ' + entry.title + '\n\n' + entry.content;
    if (existing.some((document) => document.text.startsWith(signature))) continue;
    const filename = 'learned-' + agent + '-' + stamp + '-' + index + '-' + suffix + '.md';
    const id = directory + '/' + filename;
    const destination = join(cwd, 'knowledge', id);
    const parent = resolve(destination, '..');
    await safePath(cwd, destination, { missing: true });
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await safePath(cwd, parent);
    const document =
      signature + '\n\n' +
      '_Registrado pelo agente ' + agent + '._\n';
    const bytes = Buffer.byteLength(document);
    if (bytes > 8192) {
      throw knowledgeError('registro de knowledge excede 8 KiB.');
    }
    if (existing.length + ids.length >= 500 || totalBytes + bytes > 5 * 1024 * 1024) {
      throw knowledgeError('Knowledge excede o limite de 500 documentos ou 5 MiB.');
    }
    try {
      await writeFile(destination, document, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw knowledgeError('colisão ao gravar knowledge; tente novamente.', 'KNOWLEDGE_EXISTS');
      }
      throw error;
    }
    ids.push(id);
    totalBytes += bytes;
    existing.push({ id, text: document });
  }
  return ids;
}
