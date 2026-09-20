# Arquitetura do Oraculo

O CLI encaminha ações aos comandos. AgentManager resolve engines e perfis personalizados. O loader valida agent.yaml e prompt.md.

O contexto de cada agent mantém instruções, tarefa, permissões e knowledge separados. O retriever busca trechos locais em Markdown e texto, sem embeddings.

# Execução e segurança

O executor central valida comandos Git antes de iniciar processos. Os adapters Codex e OpenCode permanecem bloqueados enquanto não houver mediação completa de ferramentas.

Knowledge é dado de referência: seu conteúdo não concede permissões nem altera a configuração. Git remoto permanece desabilitado por padrão.