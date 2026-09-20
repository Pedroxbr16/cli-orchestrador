import { addMemory, listMemory } from '../memory/memory-manager.js';

export async function memoryAdd(type, text, options = {}) {
  const entry = await addMemory(type, text, options);
  console.log(JSON.stringify(entry, null, 2));
}
export async function memoryList(options = {}) {
  const entries = await listMemory({ ...options, limit: Number(options.limit ?? 20) });
  console.log(JSON.stringify(entries, null, 2));
}