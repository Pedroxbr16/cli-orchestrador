import { execa } from 'execa';

export class CodexAdapter {
  constructor() {
    this.name = 'Codex';
    this.command = 'codex';
  }

  async run(prompt, options = {}) {
    const cwd = options.cwd ?? process.cwd();

    try {
      const { stdout } = await execa(
        this.command,
        [
          'exec',
          '--skip-git-repo-check',
          prompt,
        ],
        {
          cwd,
          stdin: 'ignore',
          reject: true,
          env: {
            ...process.env,
          },
        }
      );

      return stdout;
    } catch (error) {
      const stderr = error.stderr ?? '';
      const output = `${stderr}\n${error.stdout ?? ''}`;

      if (error.code === 'ENOENT') {
        throw new Error(
          'Codex CLI não encontrado no PATH.'
        );
      }

      if (
        output.includes("You've hit your usage limit") ||
        output.includes('usage limit')
      ) {
        throw new Error(
          'O Codex está instalado e funcionando, mas o limite de uso da conta foi atingido.'
        );
      }

      if (output.includes('Not inside a trusted directory')) {
        throw new Error(
          'O Codex recusou executar fora de um diretório Git confiável.'
        );
      }

      throw new Error(
        `Codex retornou erro:\n${stderr || error.message}`
      );
    }
  }
}