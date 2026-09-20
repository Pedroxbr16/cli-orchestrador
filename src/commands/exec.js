import { executeCommand } from '../shell/executor.js';

export async function execCommand(argv, options = {}) {
  const result = await executeCommand(argv, options);
  if (result.dryRun) {
    console.log('Permitido pela configuração (dry-run): ' + JSON.stringify(argv));
    console.log('Nenhum processo foi iniciado; repositório e transporte serão verificados na execução.');
  } else {
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (!result.success && result.code) console.error(result.code);
  }
  return result;
}