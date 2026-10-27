# pi-subagents-queue

Fila ordenada e resiliente de subagentes para o **Pi Coding Agent**, suportando agentes híbridos (**ACP Subagents** e **Pi Subagents nativos**) com failover automático, interface interativa TUI e registro persistente de erros e cotas.

## Recursos

- **Suporte Híbrido**: Enfileire subagentes ACP (`acp-subagent: <agent>:<model>`) e Pi nativos (`pi: <model>`).
- **Failover Automático**: Interceptação em tempo real de falhas upstream (erros HTTP 400, 401, 429 de cotas/rate limit, 500/503 e timeouts de rede), rotacionando a execução instantaneamente para o próximo subagente elegível da fila.
- **TUI Interativa**: Gerenciamento visual da fila diretamente na interface do Pi (`/subagents-queue tui`), permitindo reordenar, alternar status ativo, adicionar e remover agentes com pré-visualização.
- **Ferramenta Nativa do Modelo**: Registra a ferramenta `subagent_queue` permitindo que o modelo orquestrador delegue tarefas diretamente ou inspecione o estado da fila.
- **Logs e Diagnóstico**: Histórico completo de eventos e erros gravado de forma persistente com detalhes estruturados.

## Instalação

Adicione o pacote nas extensões do Pi ou clone neste diretório (`~/.pi/agent/extensions/subagents-queue`):

```json
{
  "name": "pi-subagents-queue",
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## Comandos

- `/subagents-queue`: Abre a TUI interativa de gerenciamento da fila.
- `/subagents-queue list`: Exibe a lista atual e o agente ativo no status.
- `/subagents-queue next`: Avança manualmente para o próximo subagente.
- `/subagents-queue select <n>`: Seleciona diretamente o subagente número `n`.
- `/subagents-queue add <spec>`: Adiciona um novo subagente à fila.
- `/subagents-queue remove <n>`: Remove o subagente número `n`.
- `/subagents-queue move <origem> <destino>`: Reordena as posições na fila.
- `/subagents-queue logs`: Exibe as últimas falhas e eventos registrados.
- `/subagents-queue reset`: Restaura a fila para a configuração padrão.

## Testes

Execute a suíte de testes com:

```bash
npm test
```
