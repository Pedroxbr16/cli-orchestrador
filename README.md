# Oraculo

CLI local em JavaScript/ESM para orquestrar agentes de desenvolvimento.
As Fases 1 a 5 e 8 a 11 estão implementadas: configuração, doctor, Git Guard, agents personalizados, Knowledge Base, Router, Worktrees, execução Codex somente leitura, modelo por agente e chat interativo.

**Estado atual do ask:** na Fase 10, apenas perfis Codex com permissões
efetivas read-only executam (sandbox somente leitura, ver seção Fase 10).
OpenCode continua bloqueado e Codex com escrita continua recusado, por decisão
de segurança do projeto: os adapters ainda não mediam todas as ferramentas
desses fluxos. A integração segura completa é necessária para liberá-los.

## Instalação

No Linux/WSL, com Node 24 e npm:

```bash
npm install
npm link
oraculo --help
```

> Migração de `maestro`: renomeie `maestro.config.json` para
> `oraculo.config.json` e `.maestro/` para `.oraculo/`, rode `npm link`
> de novo (o binário antigo `maestro` pode ser removido com
> `npm unlink -g maestro`) e use `oraculo` nos comandos abaixo.

Em projeto novo, crie a estrutura base (sem sobrescrever nada existente):

```bash
oraculo init
oraculo init --dry-run
```

`init` gera `oraculo.config.json` (defaults), `agents/`,
`knowledge/global/`, `knowledge/projects/` e `.oraculo/` (sessions, memory,
cache, logs, tasks). O que já existe é apenas relatado em `existing`;
symlinks ou arquivos no lugar de pastas recusam a operação. Exige filesystem
em read-write. `--dry-run` mostra `created` sem criar nada.

## Diagnóstico

```bash
oraculo doctor
```

Verifica Node, npm, Git, Codex, OpenCode, configuração, agente padrão e
repositório. Mostra as permissões e o bloqueio dos agentes.

As verificações usam `--version` e `git rev-parse`, com timeout de 5 segundos,
sem prompts de IA nem operações remotas. São diagnósticos de instalação,
não tarefas autorizadas pelo Git Guard. Autenticação e quota não são verificadas.

`OK` indica sucesso; `AVISO` indica limitações ou engine opcional ausente;
`ERRO` indica configuração inválida, Node incompatível, npm/Git indisponível
ou agente padrão desconhecido/indisponível. Retorna 1 se houver erros e 0 caso
contrário. Um diagnóstico sem erros não significa que o ask está liberado.

## Comandos protegidos (Fase 3)

Execute na raiz do repositório:

```bash
oraculo exec -- git status --short
oraculo exec -- git diff --stat
oraculo exec -- git log --oneline --max-count=10
oraculo exec -- git branch
oraculo exec -- git branch feature/minha-feature
oraculo exec -- git add src/
oraculo exec -- git commit -m "Minha alteração"
oraculo exec --dry-run -- git push origin feature/minha-feature
```

O separador `--` encaminha os argumentos seguintes ao comando Git.
O executor recebe argumentos separados e nunca usa shell. Não aceita uma
string como `"git status && git push"`.

O `--dry-run` valida a política e não inicia processos, nem altera arquivos.
Ele não confirma a validade do repositório, a URL remota ou a disponibilidade
de autenticação. Um comando negado continua negado em dry-run.

### Operações suportadas

| Operação | Requisitos |
| --- | --- |
| status, diff, log, branch (listagem), remote -v | filesystem e Git local com leitura |
| add, commit -m, branch (criação) | filesystem e Git local em read-write |
| ls-remote origin | leitura local e Git remoto com leitura |
| fetch origin | escrita local e Git remoto com leitura |
| push origin feature | leitura local e Git remoto em read-write; proteções adicionais |

A lista de flags é deliberadamente limitada. Exemplos: status aceita
`--short`, `--branch` e `--porcelain`; diff aceita `--cached`, `--stat`,
`--name-only`, `--name-status`, `--check` e caminhos depois de `--`;
log aceita `--oneline`, `--all`, `--decorate` e `--max-count=N`.

Shells, wrappers, executáveis diferentes de Git, aliases, opções globais
(`-c`, `-C`, `--git-dir`), flags desconhecidas, caminhos externos,
`pull`, `reset`, `clean` e exclusão de branches locais são recusados.
`gh pr create` e `glab mr create` também são recusados.

Push exige exatamente um remote e uma referência explícita. O destino é
normalizado antes de verificar as proteções: `feature:main` é push para main.
Push implícito, `--all`, `--mirror`, `--tags` e curingas são recusados.
Force push (`--force`, `-f`, `--force-with-lease` ou `+` no refspec) e
exclusões (`--delete`, `-d` ou refspec vazio na origem) exigem liberação
explícita. Para tags, use o destino completo `refs/tags/nome`.

### Limites do transporte e do repositório

- Remotes devem ter uma única URL HTTPS, sem usuário, senha, query ou fragmento.
  SSH, caminhos locais, protocolos customizados e reescrita de URL são recusados.
- Hooks, assinatura automática, pagers, diff externo, textconv, recursão em
  submódulos e credential helpers são desativados no processo do Git.
  Operações que dependem de um credential helper falham sem solicitar login.
- Repositórios com filtros (incluindo Git LFS), partial clones, proxies Git ou
  helpers customizados são recusados antes da operação.
- Worktrees/diretórios Git externos e execução a partir de subdiretórios ainda
  não são suportados. Configure e execute na raiz.
- O executor usa o Git instalado no PATH e confia no sistema local. Não é um
  sandbox para código arbitrário nem protege contra alterações concorrentes
  feitas fora do Oraculo. Por isso os agentes externos permanecem bloqueados.
- Timeout e Ctrl+C encerram o processo; no Linux/WSL, o grupo de subprocessos
  também é encerrado em falhas. A execução retorna stdout, stderr, exitCode e
  duração. Não há persistência de comandos, prompts ou credenciais em logs.

## Configuração por projeto

O arquivo `oraculo.config.json` é lido no diretório atual. Sem arquivo, ou
quando campos são omitidos, estes defaults são aplicados:

```json
{
  "agents": { "default": "opencode" },
  "permissions": {
    "filesystem": "read-write",
    "gitLocal": "read-write",
    "gitRemote": "disabled"
  },
  "git": {
    "protection": {
      "forcePush": false,
      "pushMain": false,
      "pushDevelop": false,
      "deleteRemoteBranch": false,
      "deleteRemoteTag": false
    }
  },
  "runtime": { "timeout": 300000 }
}
```

Opcionalmente, inclua `"project": { "name": "meu-projeto" }`.
Os níveis de acesso são `disabled`, `read-only` e `read-write`.
As proteções usam a convenção de **permissão**: `false` bloqueia a operação;
`true` a libera, ainda respeitando os demais níveis de acesso.
`runtime.timeout` é um inteiro positivo em milissegundos, aplicado por processo.

JSON inválido, arquivo vazio, campos desconhecidos e tipos incorretos geram
erro claro antes de executar a tarefa. Configuração global ainda não é suportada.

Inspecione a configuração efetiva (arquivo + defaults) sem editar nada:

```bash
oraculo config
oraculo config agents.default
oraculo config permissions.gitLocal
```

A saída indica `source` (`oraculo.config.json` ou `defaults (arquivo
ausente)`). Caminho pontilhado desconhecido ou malformado gera erro claro;
chaves herdadas (`constructor` etc.) são recusadas. Exige leitura do
filesystem.

Altere qualquer chave por comando, com validação e escrita atômica
(temporário + rename; falha não toca no arquivo):

```bash
oraculo config set agents.default revisor
oraculo config set runtime.timeout 60000
oraculo config set git.protection.forcePush true
oraculo config unset project.name
```

O valor é interpretado como JSON (`true`, `60000`) ou texto puro
(`revisor`). Tipos, enums e limites são os do schema: valor inválido,
caminho inexistente e segmentos como `__proto__` são recusados. `unset`
remove a chave (podando objetos esvaziados) e o default volta a valer.
Exige filesystem em read-write. Para a base inicial, use `oraculo init`.

## Sintaxe de agentes (execução parcial na Fase 10)

```bash
oraculo ask "analise o projeto"
oraculo ask codex "analise o projeto"
oraculo ask opencode "analise o projeto"
```

Um único argumento seleciona `agents.default`; com dois ou mais, o primeiro
é o agente explícito. Na Fase 10, apenas perfis **Codex com permissões
efetivas read-only** (filesystem e Git local) executam de verdade, em sandbox
somente leitura (seção abaixo). Todo o resto termina em
`AGENT_POLICY_UNSUPPORTED` antes de iniciar qualquer processo: OpenCode sempre,
e Codex com escrita (`use perfil read-only`).

## Agents personalizados (Fase 4)

```bash
oraculo agents
oraculo agent create backend-developer --engine codex --role developer
oraculo agent create arquiteto --engine codex --role architect --model astra
oraculo agent show backend-developer
oraculo agent run backend-developer "implemente o endpoint"
```

`create` gera `agents/<nome>/agent.yaml` e `prompt.md`, sem sobrescrever
pastas ou arquivos existentes. O engine padrão para criação é OpenCode.
`--model` é opcional e define o modelo do engine naquele perfil
(por exemplo, `astra` no Codex ou `provedor/modelo` no OpenCode); omitido,
o engine usa o modelo padrão dele. O Oraculo repassa o valor sem validar
catálogo — modelo desconhecido é erro do engine, não do Oraculo.

Troque engine, papel, modelo ou descrição sem abrir YAML na mão:

```bash
oraculo agent update arquiteto --model astra
oraculo agent update dev --engine opencode --model muse-spark
oraculo agent update dev --clear-model
```

`update` valida tudo pelo mesmo schema da criação (engine inválido, papel
vazio e modelo vazio são recusados sem gravar), nunca toca no `prompt.md` e
exige filesystem em read-write. Sem flags, informa que não há o que
atualizar. Skills, knowledge e permissões do perfil continuam editados
direto no YAML.
Edite os dois arquivos para especializar o perfil. Nomes usam letras
minúsculas, números e hífens (até 64 caracteres); nomes de engines são reservados.

```yaml
name: backend-developer
description: Especialista em backend Node.js
engine: codex
model: astra
role: developer
skills:
  - nodejs
knowledge:
  - global/coding-standards
permissions:
  filesystem: read-write
  gitLocal: read-write
  gitRemote: disabled
prompt: ./prompt.md
```

O nome do YAML deve corresponder à pasta. `model` é opcional (1 a 200
caracteres, sem `-` inicial); campos desconhecidos, tipos incorretos,
chaves duplicadas, aliases YAML, arquivos vazios e engines não suportados são
rejeitados. YAML e prompt aceitam até 64 KiB cada. O prompt deve ser um arquivo
diretamente dentro da pasta do agent; symlinks e caminhos externos são recusados.

`show` exibe o perfil, prompt, permissões efetivas e estado de execução.
`agents` lista perfis válidos e erros individuais; retorna 1 se houver
algum perfil inválido. Criar perfis exige filesystem em read-write; listar
e mostrar exigem leitura. Essas operações usam o diretório atual.

As permissões efetivas são a interseção entre perfil e projeto: um agent
pode restringir, mas nunca ampliar, acesso. Campos de permissão omitidos
herdam o projeto. Proteções de Git e timeout continuam sendo os do projeto.

Para usar um perfil como padrão, configure `"agents": { "default": "backend-developer" }`.
`ask "tarefa"`, `ask backend-developer "tarefa"` e `agent run` resolvem
o mesmo perfil. **A execução segue bloqueada antes de iniciar o engine,
exceto Codex read-only na Fase 10 (ver seção própria).**
Criar um perfil não contorna a política estabelecida na Fase 3.

O contexto preparado mantém instruções, tarefa, skills e permissões separadas.
As fontes declaradas em knowledge são recuperadas conforme a Fase 5 abaixo.

Perfis iniciais neste repositório: `architect`, `developer`, `reviewer`
e `security`. Revisão, arquitetura e segurança usam permissões de leitura;
todos mantêm Git remoto desabilitado.


## Knowledge Base (Fase 5)

```bash
oraculo knowledge add ./docs/padroes.md --scope global
oraculo knowledge add ./docs/arquitetura.md
oraculo knowledge list
oraculo knowledge search "git permissões"
oraculo knowledge search "arquitetura" --scope project --limit 3 --json
oraculo knowledge remove global/padroes.md
```

A importação copia um arquivo `.md` ou `.txt` existente dentro do projeto;
não modifica o original nem sobrescreve documentos. O scope padrão de importação
é `project`. IDs são caminhos relativos à pasta knowledge, como
`global/padroes.md` ou `projects/meu-projeto/arquitetura.md`.
`remove` apaga apenas o documento identificado dentro da base.

Listagem e busca consideram `knowledge/global/` e
`knowledge/projects/<project.name>/`; sem nome configurado, usam o nome da
pasta atual. O nome do projeto deve ser um identificador simples, sem espaços,
barras ou sequências `..`. Outros projetos e `knowledge/index/` não entram na busca.
`global` significa compartilhado pelos perfis deste repositório, sem consulta
a diretórios globais do sistema.

A busca textual ignora caixa e acentos e retorna trechos que contenham pelo
menos um termo. O ranking prioriza a quantidade de termos distintos encontrados,
com desempate por arquivo e linha. Não há busca semântica. Arquivos são lidos
a cada consulta; não há índice persistente, banco de dados ou embeddings.

Limites: 256 KiB por arquivo UTF-8, 500 documentos/5 MiB por consulta, até 2000
entradas e 12 níveis de pastas. Arquivos binários, vazios, symlinks e caminhos
externos são recusados. A consulta aceita até 4096 caracteres; os resultados
usam trechos de até 1200 caracteres, com orçamento total de 6000 caracteres.
O limite padrão é 5 trechos, configurável entre 1 e 20.

### Knowledge no contexto dos agents

Declare fontes no `agent.yaml`:

```yaml
knowledge:
  - global/coding-standards
  - project/current
```

Uma fonte pode ser um ID completo, um nome sem extensão ou uma pasta.
`project/current` seleciona a pasta de conhecimento do projeto atual.
Fontes inexistentes geram `KNOWLEDGE_NOT_FOUND`; fontes repetidas são deduplicadas.

```bash
oraculo agent context developer "git permissões"
```

O comando mostra a prévia em JSON sem executar o engine. Apenas fontes declaradas
pelo perfil são consideradas; um perfil com `knowledge: []` não recebe documentos.
Edite o YAML para associar os exemplos desta base ao perfil desejado.

O contexto inclui IDs, linhas e trechos relevantes, separados das instruções e
marcados como dados de referência. Nenhum conteúdo da base amplia permissões.
A leitura respeita também o filesystem efetivo do agent. Se não houver termos
correspondentes, a lista de trechos fica vazia. `agent show` mostra apenas a
definição; use `agent context` para verificar a recuperação.

Foram incluídos documentos iniciais em `global/coding-standards.md` e
`projects/cli-orquestror/architecture.md`. A importação de PDFs, URLs,
embeddings e bancos vetoriais permanece fora desta fase. `ask` e `agent run`
para OpenCode e para Codex com escrita continuam bloqueados até a integração
segura desses fluxos (Codex read-only executa desde a Fase 10).

## Router (Fase 8)

```bash
oraculo route "Corrigir autenticação LDAP"
oraculo route "Implementar endpoint"
oraculo route "Revisar possíveis regressões"
oraculo route "tarefa" --skill security-review
oraculo route "tarefa" --skill nodejs --skill ldap
oraculo ask --auto "Implementar endpoint"
```

`route` apenas seleciona e explica; não executa engines e não inicia
subprocessos Codex ou OpenCode. A saída é um JSON com `selected`, `candidates`,
`fallback` e `ignored`. `selected` contém `agent`, `engine`, `score` e `reasons`.

`--skill <skill>` é repetível e declara skills obrigatórias: o candidato precisa
possuir todas elas. Uma skill obrigatória inexistente produz erro claro
(`Nenhum agent válido possui todas as skills solicitadas.`) com saída 1, sem
fallback. A tarefa aceita de 1 a 4096 caracteres; são aceitas até 20 skills,
cada uma não vazia com até 100 caracteres.

Regras de pontuação, aplicadas após a filtragem por skills obrigatórias:

| Sinal | Pontos | Motivo registrado |
| --- | --- | --- |
| cada skill obrigatória | +10 | `skills solicitadas: ...` |
| cada skill do perfil mencionada na tarefa | +5 | `skills mencionadas: ...` |
| cada termo de intenção compatível com o `role` | +3 | `intenção compatível com <role>: ...` |

A detecção de intenção é por prefixo de palavras, sem consulta semântica nem
IA: a tarefa e as skills são normalizadas (caixa baixa, sem acentos) e cada
palavra da tarefa é comparada com os termos do `role` (`architect`,
`developer`, `reviewer`, `security`). Exemplos: `autentic`/`ldap` selecionam
`security`; `implement`/`endpoint` selecionam `developer`;
`revis`/`regress` selecionam `reviewer`.

O desempate é determinístico: maior `score` primeiro, depois nome do agent em
ordem alfabética. Se o melhor `score` for zero, `selected` usa
`config.agents.default` com `score: 0`, motivo
`sem correspondência; usando agents.default` e `fallback: true`. Perfis
inválidos são ignorados e reportados em `ignored` como `{ name, error }`,
sem escolha silenciosa incorreta.

`ask --auto "tarefa"` usa o mesmo roteamento para escolher o perfil e em
seguida chama o fluxo normal de execução, que termina com
`AGENT_POLICY_UNSUPPORTED` antes de iniciar qualquer engine. As permissões do
projeto continuam respeitadas: `route` exige leitura do filesystem para carregar
configuração e perfis; `ask --auto` passa ainda pela validação de prompt,
permissões do agent e pelo bloqueio da Fase 3.

Limitações: a classificação por palavras-chave não entende sinônimos fora da
lista, contexto do repositório ou histórico; empates entre intenções são
resolvidos pelo placar e pela ordem alfabética, não por relevância real.
Engines continuam bloqueados.

## Worktrees (Fase 9)

```bash
oraculo worktree list
oraculo worktree create equipe-a --branch wt/equipe-a
oraculo worktree create --dry-run demo
oraculo worktree remove equipe-a
oraculo worktree remove --force equipe-a
oraculo worktree plan "implementar autenticação LDAP"
```

Worktrees isolam checkouts Git para futura execução paralela: cada agent recebe
seu próprio diretório e branch, em vez de dois agents modificarem a mesma
árvore. Nenhum comando desta fase executa engines e nenhum inicia subprocessos
Codex ou OpenCode; apenas o binário `git` é invocado, com os mesmos
endurecimentos do Git Guard (sem shell, sem hooks, sem credential helpers).
`ask`, `agent run` e `pipeline` sem `--dry-run` continuam bloqueados com
`AGENT_POLICY_UNSUPPORTED`.

`list` mostra as worktrees registradas em JSON (`path`, `head`, `branch`,
`bare`, `detached`), incluindo o checkout principal. Exige leitura do
filesystem. `create <nome>` gera `worktrees/<nome>` com uma branch **nova**
(`-b`); a branch padrão é `wt/<nome>`. Reutilizar branch ou nome existente
falha com erro explícito, sem efeitos colaterais. `remove <nome>` apaga o
checkout (a branch permanece; apague com `git branch -d` quando não precisar
mais); sem `--force`, o Git protege worktrees com alterações não salvas e o
Oraculo repassa o erro. `create` e `remove` exigem filesystem e Git local em
read-write. `--dry-run` valida permissões, nome e branch e mostra o plano sem
criar ou remover nada.

`plan "tarefa" [--file pipeline]` é planejamento puro: combina os steps do
pipeline com um worktree por etapa (`worktrees/<agent>-<índice>`, determinístico
e sem colisões mesmo quando o mesmo agent aparece em várias etapas), sem criar
diretórios, branches ou processos. A saída traz `execution:
blocked-until-secure-engine` para execuções com escrita; Codex somente leitura
executa via `ask` desde a Fase 10 (seção abaixo).

Regras e limites: nomes usam letras minúsculas, números e hífens, começando com
letra (até 64 caracteres); branches seguem a validação de referências do Git
Guard (sem `..`, `//` ou `.lock`); o path deriva do nome validado, então
travessia (`..`), caminhos absolutos e symlinks são recusados por construção, e
a pasta `worktrees/` nunca pode ser symlink. A tarefa do `plan` aceita de 1 a
4096 caracteres. O checkout principal nunca está sob `worktrees/<nome>`, então
`remove` nunca apaga a raiz do repositório. `oraculo exec` continua restrito à
raiz: executado de dentro de uma worktree, é recusado com a mensagem de Git
externo ainda não suportado. A pasta `worktrees/` está no `.gitignore` para não
ser commitada por acidente.

## Execução Codex somente leitura (Fase 10)

```bash
oraculo ask leitor "resuma notas.txt em uma frase"
oraculo ask --auto "revisar possíveis regressões"
oraculo agent run leitor "liste os módulos"
```

Na Fase 10, `ask`, `ask --auto` e `agent run` executam de verdade quando o
perfil resolvido usa o engine **codex** com permissões efetivas **read-only**
(filesystem e Git local). A resposta do motor é impressa em texto. Todo o resto
continua recusado com `AGENT_POLICY_UNSUPPORTED` antes de qualquer subprocesso:
OpenCode sempre, Codex com escrita e `pipeline` sem `--dry-run`. `agent show`
indica `execution: read-only` para perfis executáveis e `blocked` para os demais.

Cada execução cria uma worktree efêmera `worktrees/<agent>-ask-<id>` (branch
nova `wt/<agent>-ask-<id>`) e chama:

```text
codex exec -s read-only -c approval_policy="never"
  --ignore-user-config --ignore-rules --ephemeral --json
  -C <worktree> -o <resposta> "<tarefa + instruções + referências>"
```

Mapeamento e travas (fail-closed):

| Regra | Efeito |
| --- | --- |
| `-s read-only` + `approval_policy="never"` | leitura sem escalonamento; nada além de leitura é tentado com aprovação |
| `--ignore-user-config` + `--ignore-rules` | config do usuário e `.rules` de projeto não enfraquecem a política |
| `danger-full-access`, `--approve-for-me`, `--dangerously-bypass-*`, `--auto`, `--add-dir`, worktree gerenciada pelo Codex e `--skip-git-repo-check` | nunca passados; verificados no argv por teste |
| `git status --porcelain` na worktree após a execução | qualquer modificação vira `GIT_POLICY_DENIED`, resposta descartada e worktree preservada para auditoria |
| sucesso com árvore limpa | worktree e branch `wt/*` removidas (`cleaned: true`) |
| falha do engine com árvore limpa | worktree removida; falha com árvore suja ou limpeza impossível preserva o path no erro |

Pré-requisitos: projeto com filesystem em `read-write` (a worktree e a
auditoria são infra do Oraculo; o agent permanece read-only), binário `codex`
no PATH e autenticação/quota do engine. Sem contexto, sem resposta, timeout,
binário ausente, auth e quota viram erros tipados (`AGENT_EXECUTION_ERROR`,
`AGENT_TIMEOUT`, `AGENT_BINARY_NOT_FOUND`, `AGENT_AUTH_ERROR`,
`AGENT_USAGE_LIMIT`); cancelamento (Ctrl+C) encerra o subprocesso. A resposta é
limitada a 32 KiB. Cada execução anexa uma linha a
`.oraculo/logs/agents.jsonl` com metadados (agent, engine, sandbox, worktree,
duração, status, limpeza) — nunca prompt, resposta, tokens ou credenciais. O
Oraculo reaproveita a autenticação existente do engine sem injetar chaves.

Para executar nesta fase, o perfil precisa de `engine: codex` com
`filesystem: read-only` e `gitLocal: read-only` (crie com `oraculo agent
create <nome> --engine codex` e ajuste o YAML). Nenhum perfil inicial deste
repositório combina codex + read-only, então `ask` nos perfis iniciais segue
bloqueado; a Fase 10 foi validada com perfil temporário e motor simulado nos
testes, além de execução real supervisionada.

Limitações honestas: o sandbox é o do Codex (delegado, não reimplementado);
saída de rede do sandbox read-only e exfiltração via resposta não são
bloqueadas — não use em repositórios sensíveis sem isolamento de rede externo.
Conteúdo do repositório e da knowledge é tratado como dado não confiável no
prompt, mas a garantia real é o sandbox + a pós-verificação, nunca o texto.
Escrita, OpenCode e pipelines com execução seguem para fases futuras, sem
reativar adapter sem enforcement.

## Modelo por agente e chat interativo (Fase 11)

Cada perfil define **quem executa e com qual modelo**:

```yaml
# agents/arquiteto/agent.yaml
name: arquiteto
engine: codex
model: astra
role: architect
```

```yaml
# agents/dev/agent.yaml
name: dev
engine: opencode
model: muse-spark
role: developer
```

`route` inclui `model` em `selected` e `candidates` (nulo no fallback para
engine direto); `agent show` exibe o modelo; o Codex recebe `-m <model>` na
Fase 10 (omitido sem `--model`). Para OpenCode o modelo fica registrado no
perfil e será consumido pelo adapter dele quando houver integração segura.

```bash
oraculo chat
oraculo chat arquiteto
oraculo chat --auto
```

`chat` é a interface interativa no estilo dos CLIs dos engines: loop
pergunta-resposta com prompt `oraculo/<agente> `. Sem agente, usa
`agents.default`; com `--auto`, cada mensagem é roteada como em `route`
(mostra `→ agente (engine, model): motivos`). Comandos: `/help`, `/agent
[nome]` (mostra ou troca), `/sair` (Ctrl+D também encerra); Ctrl+C cancela o
turno em andamento sem sair. Linha vazia é ignorada; erro de um turno não
encerra a sessão. Entrada por pipe funciona (processa até EOF): `echo "revise
X" | oraculo chat revisor`.

O chat usa exatamente o funil do `ask` — mesmas permissões, mesmo bloqueio,
mesma auditoria — então tudo da Fase 10 vale por turno: só Codex read-only
executa; OpenCode e escrita recusam com `AGENT_POLICY_UNSUPPORTED`. Sem
persistência de histórico entre sessões.

Com TTY, cada turno mostra spinner (`ora`) e cores (`chalk`); em pipe a saída
é texto puro e determinístico. O histórico das tarefas vai para
`.oraculo/chat-history` (últimas 200 linhas, `0o600`), carregado na sessão
seguinte para recall com `↑`; comandos `/` não são persistidos. Persistência
respeita o filesystem do projeto (read-only só avisa) e nunca interrompe a
sessão. Ctrl+C cancela o turno sem sair.

## Testes

```bash
npm test
```

A suíte cobre configuração, doctor, parsing, permissões, proteções de push,
bloqueio dos adapters, timeout/cancelamento, operações em repositórios
temporários, roteamento determinístico por intenção/skills, fallback,
perfis inválidos, ciclo de vida de worktrees, execução Codex somente leitura
(argv travado, classificação de falhas, violação com preservação e limpeza),
modelo por agente (`create --model`, `agent update`) e chat interativo (spinner/cores no TTY, histórico capado
em `.oraculo/chat-history`, corrida de pipe corrigida), init idempotente
e config get/set/unset
com validação zod e escrita atômica.
Não usa serviços de IA nem executa pushes/fetches reais; o engine real nunca
é invocado nos testes (motor simulado via PATH).

## Próximas etapas

Adapter OpenCode com mediação equivalente, tarefas de escrita em worktrees
isoladas (com verificação e aprovação explícita) e pipelines com execução
seguem no roadmap.
Nenhuma dessas etapas deve reativar um adapter sem enforcement das políticas.

Referências de implementação: [segurança do Codex](https://developers.openai.com/pt-BR/docs/agent-approvals-security),
[Git](https://git-scm.com/docs/git) e [refspecs de push](https://git-scm.com/docs/git-push).
