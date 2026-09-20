import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configSchema } from './schema.js';

export async function loadConfig({ cwd = process.cwd() } = {}) {
  const file = resolve(cwd, 'oraculo.config.json');
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return configSchema.parse({});
    throw configError(file, `Não foi possível ler o arquivo (${error.code}).`, error);
  }
  let data;
  try {
    data = JSON.parse(source);
  } catch (error) {
    throw configError(file, 'JSON inválido. Verifique aspas, vírgulas e chaves.', error);
  }
  const result = configSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((issue) =>
      `${issue.path.join('.') || 'config'}: ${issue.message}`
    ).join('\n');
    throw configError(file, details, result.error);
  }
  return result.data;
}

function configError(file, details, cause) {
  const error = new Error(`Configuração inválida em ${file}:\n${details}`, { cause });
  error.code = 'CONFIG_INVALID';
  return error;
}