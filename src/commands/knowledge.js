import { addDocument, listDocuments, removeDocument } from '../knowledge/knowledge-manager.js';
import { searchDocuments } from '../knowledge/retriever.js';

export async function knowledgeAdd(source, options = {}) {
  const id = await addDocument(source, options);
  console.log('Documento adicionado: ' + id);
}
export async function knowledgeList(options = {}) {
  const documents = await listDocuments(options);
  for (const document of documents) console.log(document.id + ' | ' + document.title);
  if (!documents.length) console.log('Nenhum documento encontrado.');
}
export async function knowledgeSearch(query, options = {}) {
  const results = searchDocuments(await listDocuments(options), query, { limit: Number(options.limit ?? 5) });
  if (options.json) console.log(JSON.stringify(results, null, 2));
  else {
    for (const result of results) console.log(result.id + ':' + result.line + '\n' + result.text + '\n');
    if (!results.length) console.log('Nenhum resultado encontrado.');
  }
  return results;
}
export async function knowledgeRemove(id, options = {}) {
  await removeDocument(id, options);
  console.log('Documento removido: ' + id);
}