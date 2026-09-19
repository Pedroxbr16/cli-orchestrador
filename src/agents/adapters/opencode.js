import { execa } from 'execa';

export class OpenCodeAdapter {
  constructor() {
    this.name = 'OpenCode';
    this.command = 'opencode';
  }

  async run(prompt, options = {}) {
    const cwd = options.cwd ?? process.cwd();

    try {
      const { stdout } = await execa(
        this.command,
        [
          'run',
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
      if (error.code === 'ENOENT') {
        throw new Error(
          'OpenCode CLI não encontrado. Verifique se o comando "opencode" está instalado e disponível no PATH.'
        );
      }

      if (error.stderr) {
        throw new Error(`OpenCode retornou erro:\n${error.stderr}`);
      }

      throw error;
    }
  }
}