import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { readFile } from 'node:fs/promises';
import { loadConfig as loadAcpConfig } from '../acp-subagents/config.mjs';
import {
  advanceQueueOnFailure,
  DEFAULT_QUEUE,
  detectFailureError,
  formatQueueItem,
  formatQueueList,
  getModelsJsonPath,
  getQueueConfigPath,
  getQueueLogPath,
  loadQueueConfig,
  parseQueueEntry,
  saveQueueConfig,
} from './queue.mjs';

const KEY = 'subagents-queue';
const SECTION = 'subagents_queue_routing';

export default function subagentsQueueExtension(pi: ExtensionAPI) {
  let uiContext: ExtensionContext | undefined;
  let cachedConfig: Awaited<ReturnType<typeof loadQueueConfig>> | undefined;
  const handledFailureIds = new Set<string>();

  async function refreshState(ctx = uiContext) {
    try {
      cachedConfig = await loadQueueConfig();
    } catch {
      cachedConfig = { activeIndex: 0, queue: structuredClone(DEFAULT_QUEUE) };
    }
    if (ctx?.hasUI) {
      const active = cachedConfig.queue[cachedConfig.activeIndex];
      const label = active
        ? `Fila[${cachedConfig.activeIndex + 1}/${cachedConfig.queue.length}]: ${active.type === 'acp-subagent' ? 'acp' : 'pi'}:${active.id}`
        : undefined;
      ctx.ui.setStatus(KEY, label);
    }
    return cachedConfig;
  }

  pi.registerMessageRenderer(KEY, (message, _options, theme) => {
    const text = typeof message.content === 'string'
      ? message.content
      : message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    const style = (color: string, s: string) => theme?.fg ? theme.fg(color as any, s) : s;
    return new Text(style('warning', text), 0, 0);
  });

  function buildFailoverPrompt(failover: Awaited<ReturnType<typeof advanceQueueOnFailure>>, details: { runId?: string; task?: string; partialOutput?: string }) {
    const prev = failover.failedAgent;
    const next = failover.nextAgent;
    const nextCallHint = next.type === 'acp-subagent'
      ? `acp_subagent({"tasks":[{"agent":"${next.agent}","model":"${next.model ?? ''}","task":"..."}]}) ou subagent_queue({"action":"delegate","task":"..."})`
      : `subagent({"agent":"${next.agent ?? 'delegate'}","model":"${next.model}","task":"..."}) ou subagent_queue({"action":"delegate","task":"..."})`;

    const lines = [
      `[SUBAGENTS-QUEUE FAILOVER] Erro detectado no subagente #${failover.previousIndex + 1} (${prev.type}: ${prev.id}) — Código: ${failover.logEntry.code}.`,
      `Motivo: ${failover.logEntry.reason}`,
      `Log gravado em: ${getQueueLogPath()}`,
      `Fila avançada automaticamente para #${failover.nextIndex + 1}: ${next.type}: ${next.id} (${next.type === 'acp-subagent' ? `agent=${next.agent}, model=${next.model}` : `role=${next.agent ?? 'delegate'}, model=${next.model}`}).`,
      '',
      'DECISÃO DO MODELO PRINCIPAL (escolha a melhor opção antes de prosseguir):',
      '1. Reenviar a MESMA tarefa integralmente para o próximo subagente da fila (caso nenhum trabalho útil tenha sido concluído ou salvo).',
      '2. Resumir e enviar um CHECKPOINT do que o subagente anterior já realizou (arquivos alterados, descobertas parciais) e especificar apenas o que falta concluir.',
      `Como acionar o próximo agente da fila: ${nextCallHint}`,
    ];
    if (details.task) {
      lines.push(`Tarefa original: ${String(details.task).slice(0, 400)}`);
    }
    if (details.partialOutput) {
      lines.push(`Saída parcial observada:\n${String(details.partialOutput).slice(-600)}`);
    }
    return lines.join('\n');
  }

  async function handleDetectedError(params: {
    failedItem?: any;
    errorInfo: { code: number; reason: string };
    runId?: string;
    task?: string;
    partialOutput?: string;
    notifyTurn?: boolean;
  }) {
    const dedupeKey = params.runId || `${params.failedItem?.type}:${params.failedItem?.id}:${params.errorInfo.code}:${Date.now() >> 11}`;
    if (handledFailureIds.has(dedupeKey)) return null;
    handledFailureIds.add(dedupeKey);
    if (handledFailureIds.size > 200) {
      const first = handledFailureIds.values().next().value;
      if (first) handledFailureIds.delete(first);
    }

    const failover = await advanceQueueOnFailure({
      failedItem: params.failedItem,
      errorInfo: params.errorInfo,
      runId: params.runId,
      task: params.task,
    });
    await refreshState();

    if (uiContext?.hasUI) {
      uiContext.ui.notify(
        `Fila Subagents: erro ${params.errorInfo.code} em ${failover.failedAgent.type}:${failover.failedAgent.id} → alternado para #${failover.nextIndex + 1} (${failover.nextAgent.type}:${failover.nextAgent.id})`,
        'warning',
      );
    }

    const messageText = buildFailoverPrompt(failover, {
      runId: params.runId,
      task: params.task,
      partialOutput: params.partialOutput,
    });

    if (params.notifyTurn !== false) {
      pi.sendMessage({
        customType: KEY,
        content: messageText,
        display: true,
        details: { failover },
      }, { triggerTurn: true, deliverAs: 'followUp' });
    }

    return { failover, messageText };
  }

  // Listen to ACP background run events
  pi.events.on('acp-subagents:event', async (payload: any) => {
    const run = payload?.run;
    const event = payload?.event;
    if (!run || event === 'attention') return;

    const textToInspect = [run.error, run.notice, run.stderr].filter(Boolean).join('\n');
    const errorInfo = detectFailureError(textToInspect, run.status);
    if (!errorInfo) return;

    await handleDetectedError({
      failedItem: {
        type: 'acp-subagent',
        id: run.model ? String(run.model).replace(new RegExp(`^${run.agent}/`), '') : run.agent,
        agent: run.agent,
        model: run.model,
      },
      errorInfo,
      runId: run.id,
      task: run.task,
      partialOutput: run.text,
      notifyTurn: true,
    });
  });

  // Listen to pi-subagents async & foreground completion events
  for (const eventName of ['subagent:async-complete', 'subagent:foreground-complete']) {
    pi.events.on(eventName, async (data: any) => {
      if (!data) return;
      const results = Array.isArray(data.results) ? data.results : [];
      const failedChild = results.find((r: any) => r?.success === false || r?.status === 'failed' || r?.error || r?.timedOut);
      const isFailed = data.success === false || data.state === 'failed' || data.timedOut === true || Boolean(failedChild);
      if (!isFailed) return;
      if (data.cancelled || data.state === 'cancelled' || data.state === 'stopped') return;
      if (typeof data.summary === 'string' && /session (?:was )?replaced or reloaded|workflow stopped because extension session/i.test(data.summary)) return;

      const errText = [
        data.summary,
        failedChild?.error,
        failedChild?.output,
        data.timedOut ? 'timed_out' : '',
      ].filter(Boolean).join('\n');

      const errorInfo = detectFailureError(errText, isFailed ? 'failed' : 'completed');
      if (!errorInfo) return;

      const config = cachedConfig ?? await refreshState();
      const current = config.queue[config.activeIndex];
      await handleDetectedError({
        failedItem: current?.type === 'pi' ? current : {
          type: 'pi',
          id: failedChild?.agent || data.agent || 'pi-subagent',
          agent: failedChild?.agent || data.agent || 'delegate',
        },
        errorInfo,
        runId: data.runId || data.id || failedChild?.runId,
        task: data.taskInfo || undefined,
        partialOutput: failedChild?.output || data.summary,
        notifyTurn: true,
      });
    });
  }

  // Intercept tool_call to route / pin the active queue item's model/agent when applicable
  pi.on('tool_call', async (event, ctx) => {
    uiContext = ctx;
    const config = cachedConfig ?? await refreshState(ctx);
    const active = config.queue[config.activeIndex];
    if (!active) return;

    if (event.toolName === 'acp_subagent') {
      const input = event.input as { tasks?: Array<{ agent: string; task: string; cwd?: string; model?: string }> };
      if (Array.isArray(input?.tasks)) {
        for (const t of input.tasks) {
          if (!t || typeof t !== 'object') continue;
          if (active.type === 'acp-subagent') {
            if (!t.agent || t.agent === 'auto' || t.agent === 'queue' || t.agent === active.id) {
              t.agent = active.agent;
            }
            if (t.agent === active.agent && !t.model && active.model) {
              t.model = active.model;
            }
          } else {
            // Look up if any queue item matches this ACP agent to apply its configured model
            const matchingAcp = config.queue.find(q => q.type === 'acp-subagent' && (q.agent === t.agent || q.id === t.agent));
            if (matchingAcp) {
              t.agent = matchingAcp.agent;
              if (!t.model && matchingAcp.model) t.model = matchingAcp.model;
            }
          }
        }
      }
    } else if (event.toolName === 'subagent') {
      const input = event.input as Record<string, any>;
      // Only mutate execution calls (not management actions like list/status/guide)
      if (!input.action && (input.agent !== undefined || input.task !== undefined)) {
        if (active.type === 'pi') {
          if (!input.agent || input.agent === 'auto' || input.agent === 'queue') {
            input.agent = active.agent || 'delegate';
          }
          if (!input.model && active.model) {
            input.model = active.model;
          }
        } else {
          const matchingPi = config.queue.find(q => q.type === 'pi');
          if (matchingPi && !input.model && matchingPi.model) {
            input.model = matchingPi.model;
          }
        }
      }
    }
  });

  // Inspect synchronous tool_result errors from subagent or acp_subagent
  pi.on('tool_result', async (event, ctx) => {
    uiContext = ctx;
    if (event.toolName !== 'subagent' && event.toolName !== 'acp_subagent') return;

    const contentText = (event.content ?? [])
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    const details = event.details as any;
    const runError = details?.error || details?.runs?.[0]?.error || details?.results?.[0]?.error || '';
    const combined = [runError, event.isError ? contentText : ''].filter(Boolean).join('\n');
    const errorInfo = detectFailureError(combined, event.isError ? 'error' : '');
    if (!errorInfo) return;

    const config = cachedConfig ?? await refreshState(ctx);
    let failedItem = config.queue[config.activeIndex];
    if (event.toolName === 'acp_subagent') {
      const agentName = (event.input as any)?.tasks?.[0]?.agent;
      const matched = config.queue.find(q => q.type === 'acp-subagent' && (q.agent === agentName || q.id === agentName));
      if (matched) {
        failedItem = matched;
      } else if (failedItem?.type !== 'acp-subagent') {
        failedItem = config.queue.find(q => q.type === 'acp-subagent') ?? {
          type: 'acp-subagent',
          id: agentName || 'acp-subagent',
          agent: agentName || 'opencode',
        };
      }
    } else if (event.toolName === 'subagent') {
      const agentRole = (event.input as any)?.agent;
      const matched = config.queue.find(q => q.type === 'pi' && (q.agent === agentRole || q.id === (event.input as any)?.model));
      if (matched) {
        failedItem = matched;
      } else if (failedItem?.type !== 'pi') {
        failedItem = config.queue.find(q => q.type === 'pi') ?? {
          type: 'pi',
          id: (event.input as any)?.model || 'pi-subagent',
          agent: agentRole || 'delegate',
        };
      }
    }

    const outcome = await handleDetectedError({
      failedItem,
      errorInfo,
      runId: details?.runs?.[0]?.id || details?.runId || event.toolCallId,
      task: (event.input as any)?.task || (event.input as any)?.tasks?.[0]?.task,
      partialOutput: contentText,
      notifyTurn: false, // Append directly to tool_result so the model sees it immediately in the same turn
    });

    if (outcome) {
      return {
        content: [
          ...(event.content ?? []),
          { type: 'text', text: `\n\n${outcome.messageText}` },
        ],
      };
    }
  });

  pi.on('before_agent_start', async (event, ctx) => {
    uiContext = ctx;
    const config = await refreshState(ctx);
    const active = config.queue[config.activeIndex];
    if (!active) return;

    const queueSummary = config.queue
      .map((item, i) => `${i + 1}. ${item.type}: ${item.id} (${item.type === 'acp-subagent' ? `agent=${item.agent}, model=${item.model}` : `role=${item.agent ?? 'delegate'}, model=${item.model}`})${i === config.activeIndex ? ' [ATIVO]' : ''}`)
      .join('\n');

    event.systemPromptOptions.sections[SECTION] = [
      'Subagent Queue Routing (fila de subagentes ordenada por prioridade):',
      queueSummary,
      `Subagente ativo atual (#${config.activeIndex + 1}): ${active.type}: ${active.id}.`,
      active.type === 'acp-subagent'
        ? `Para delegar ao subagente ativo (#${config.activeIndex + 1}), use subagent_queue({"action":"delegate","task":"..."}) ou acp_subagent({"tasks":[{"agent":"${active.agent}","model":"${active.model ?? ''}","task":"..."}]}).`
        : `Para delegar ao subagente ativo (#${config.activeIndex + 1}), use subagent_queue({"action":"delegate","task":"..."}) ou subagent({"agent":"${active.agent ?? 'delegate'}","model":"${active.model}","task":"..."}).`,
      'Em caso de erro (400, 429, 500, timeout, etc.), a extensão registra no log e avança a fila automaticamente para o próximo subagente; cabe a você decidir se reenvia a tarefa integralmente ou se envia um resumo/checkpoint do progresso anterior e o que falta fazer.',
    ].join('\n');
  });

  pi.on('session_start', async (_event, ctx) => {
    uiContext = ctx;
    await refreshState(ctx);
  });

  pi.on('session_shutdown', () => {
    if (uiContext?.hasUI) uiContext.ui.setStatus(KEY, undefined);
    uiContext = undefined;
  });

  // Register unified subagent_queue tool for the LLM
  pi.registerTool({
    name: 'subagent_queue',
    label: 'Subagent Queue',
    description: 'List, configure, reorder, or delegate tasks through the ordered subagent fallback queue (mixing acp-subagents and internal Pi subagents). On errors (400, 429, 500, etc.), logs the failure and advances to the next agent in the queue.',
    promptSnippet: 'Manage or delegate via the ordered subagent queue (subagent_queue).',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('list'),
        Type.Literal('delegate'),
        Type.Literal('next'),
        Type.Literal('select'),
        Type.Literal('set'),
        Type.Literal('add'),
        Type.Literal('remove'),
        Type.Literal('move'),
        Type.Literal('reset'),
        Type.Literal('logs'),
      ]),
      task: Type.Optional(Type.String({ description: 'Task description when action="delegate"' })),
      cwd: Type.Optional(Type.String({ description: 'Working directory when action="delegate"' })),
      role: Type.Optional(Type.String({ description: 'Optional Pi subagent role override (e.g. worker, reviewer, scout, delegate)' })),
      index: Type.Optional(Type.Number({ description: '1-based queue index for select, remove, or move' })),
      toIndex: Type.Optional(Type.Number({ description: '1-based target position for move' })),
      item: Type.Optional(Type.String({ description: 'Queue entry spec e.g. "acp-subagent: deepseek-v4.1-flash-free" or "pi: kgw/kilo-auto/free"' })),
      items: Type.Optional(Type.Array(Type.String(), { description: 'Full ordered list of queue entries when action="set"' })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, onUpdate, ctx) {
      uiContext = ctx;
      const config = await loadQueueConfig();

      if (params.action === 'list') {
        const text = `Fila de Subagentes (${getQueueConfigPath()}):\n${formatQueueList(config)}\nLog: ${getQueueLogPath()}`;
        return { content: [{ type: 'text', text }], details: { config } };
      }

      if (params.action === 'logs') {
        let logContent = '';
        try {
          const raw = await readFile(getQueueLogPath(), 'utf8');
          logContent = raw.trim().split('\n').slice(-25).join('\n');
        } catch {
          logContent = 'Nenhum erro registrado no log até o momento.';
        }
        return { content: [{ type: 'text', text: `Log (${getQueueLogPath()}):\n${logContent}` }], details: { logPath: getQueueLogPath() } };
      }

      if (params.action === 'next') {
        config.activeIndex = (config.activeIndex + 1) % config.queue.length;
        const saved = await saveQueueConfig(config);
        await refreshState(ctx);
        const active = saved.queue[saved.activeIndex];
        return {
          content: [{ type: 'text', text: `Fila avançada para #${saved.activeIndex + 1}: ${active.type}: ${active.id}\n${formatQueueList(saved)}` }],
          details: { config: saved },
        };
      }

      if (params.action === 'select') {
        const idx = Number(params.index) - 1;
        if (!Number.isInteger(idx) || idx < 0 || idx >= config.queue.length) {
          throw new Error(`Índice inválido. Informe um número entre 1 e ${config.queue.length}.`);
        }
        config.activeIndex = idx;
        const saved = await saveQueueConfig(config);
        await refreshState(ctx);
        return {
          content: [{ type: 'text', text: `Subagente ativo alterado para #${idx + 1}: ${saved.queue[idx].type}: ${saved.queue[idx].id}\n${formatQueueList(saved)}` }],
          details: { config: saved },
        };
      }

      if (params.action === 'reset') {
        const saved = await saveQueueConfig({ activeIndex: 0, queue: structuredClone(DEFAULT_QUEUE) });
        await refreshState(ctx);
        return {
          content: [{ type: 'text', text: `Fila restaurada para o padrão:\n${formatQueueList(saved)}` }],
          details: { config: saved },
        };
      }

      if (params.action === 'set') {
        if (!Array.isArray(params.items) || !params.items.length) {
          throw new Error('Para action="set", forneça items: ["acp-subagent: ...", "pi: ..."].');
        }
        const newQueue = [];
        for (const rawItem of params.items) {
          newQueue.push(await parseQueueEntry(rawItem));
        }
        const saved = await saveQueueConfig({ activeIndex: 0, queue: newQueue });
        await refreshState(ctx);
        return {
          content: [{ type: 'text', text: `Fila atualizada:\n${formatQueueList(saved)}` }],
          details: { config: saved },
        };
      }

      if (params.action === 'add') {
        if (!params.item) throw new Error('Informe item (ex: "acp-subagent: deepseek-v4.1-flash-free" ou "pi: kgw/kilo-auto/free").');
        const parsed = await parseQueueEntry(params.item);
        config.queue.push(parsed);
        const saved = await saveQueueConfig(config);
        await refreshState(ctx);
        return {
          content: [{ type: 'text', text: `Adicionado à fila:\n${formatQueueList(saved)}` }],
          details: { config: saved },
        };
      }

      if (params.action === 'remove') {
        const idx = Number(params.index) - 1;
        if (!Number.isInteger(idx) || idx < 0 || idx >= config.queue.length) {
          throw new Error(`Índice inválido. Informe entre 1 e ${config.queue.length}.`);
        }
        if (config.queue.length <= 1) {
          throw new Error('A fila não pode ficar vazia.');
        }
        config.queue.splice(idx, 1);
        if (config.activeIndex >= config.queue.length) config.activeIndex = 0;
        const saved = await saveQueueConfig(config);
        await refreshState(ctx);
        return {
          content: [{ type: 'text', text: `Item removido:\n${formatQueueList(saved)}` }],
          details: { config: saved },
        };
      }

      if (params.action === 'move') {
        const from = Number(params.index) - 1;
        const to = Number(params.toIndex) - 1;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= config.queue.length || to >= config.queue.length) {
          throw new Error(`Índices inválidos. Use valores entre 1 e ${config.queue.length}.`);
        }
        const activeItem = config.queue[config.activeIndex];
        const [moved] = config.queue.splice(from, 1);
        config.queue.splice(to, 0, moved);
        config.activeIndex = Math.max(0, config.queue.indexOf(activeItem));
        const saved = await saveQueueConfig(config);
        await refreshState(ctx);
        return {
          content: [{ type: 'text', text: `Fila reordenada:\n${formatQueueList(saved)}` }],
          details: { config: saved },
        };
      }

      if (params.action === 'delegate') {
        if (!params.task?.trim()) {
          throw new Error('action="delegate" requer uma string "task" não vazia.');
        }
        const active = config.queue[config.activeIndex];
        if (!active) throw new Error('Nenhum subagente configurado na fila.');

        if (active.type === 'acp-subagent') {
          const outcome = await ctx.executeTool('acp_subagent', {
            tasks: [{
              agent: active.agent,
              ...(active.model ? { model: active.model } : {}),
              task: params.task,
              ...(params.cwd ? { cwd: params.cwd } : {}),
            }],
          }, { signal, onUpdate });

          if (outcome.isError) {
            const errText = outcome.result.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') || 'Erro ao iniciar ACP subagent';
            const errorInfo = detectFailureError(errText, 'error') ?? { matched: true, code: 500, reason: errText };
            const failover = await handleDetectedError({
              failedItem: active,
              errorInfo,
              task: params.task,
              notifyTurn: false,
            });
            throw new Error(`${errText}\n\n${failover?.messageText ?? ''}`);
          }
          return outcome.result;
        }

        // active.type === 'pi'
        const targetRole = params.role?.trim() || active.agent || 'delegate';
        const hasDirectSubagent = ctx.tools.some(t => t.name === 'subagent');
        if (hasDirectSubagent) {
          const outcome = await ctx.executeTool('subagent', {
            agent: targetRole,
            model: active.model,
            task: params.task,
            ...(params.cwd ? { cwd: params.cwd } : {}),
          }, { signal, onUpdate });

          if (outcome.isError) {
            const errText = outcome.result.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') || 'Erro no subagente Pi';
            const errorInfo = detectFailureError(errText, 'error') ?? { matched: true, code: 500, reason: errText };
            const failover = await handleDetectedError({
              failedItem: active,
              errorInfo,
              task: params.task,
              notifyTurn: false,
            });
            throw new Error(`${errText}\n\n${failover?.messageText ?? ''}`);
          }
          return outcome.result;
        }

        // Fallback via pi-subagents in-process RPC if subagent is model-only
        const requestId = crypto.randomUUID();
        const rpcReply = await new Promise<any>((resolveReply, rejectReply) => {
          const timer = setTimeout(() => {
            unsubscribe();
            rejectReply(new Error('Timeout aguardando resposta RPC de pi-subagents.'));
          }, 15000);
          const unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply: any) => {
            clearTimeout(timer);
            unsubscribe();
            resolveReply(reply);
          });
          pi.events.emit('subagents:rpc:v1:request', {
            version: 1,
            requestId,
            method: 'spawn',
            params: {
              agent: targetRole,
              model: active.model,
              task: params.task,
              ...(params.cwd ? { cwd: params.cwd } : {}),
            },
          });
        });

        if (!rpcReply?.success) {
          const errMsg = rpcReply?.error?.message || 'Falha ao iniciar subagente Pi via RPC.';
          const errorInfo = detectFailureError(errMsg, 'error') ?? { matched: true, code: 500, reason: errMsg };
          const failover = await handleDetectedError({
            failedItem: active,
            errorInfo,
            task: params.task,
            notifyTurn: false,
          });
          throw new Error(`${errMsg}\n\n${failover?.messageText ?? ''}`);
        }

        return {
          content: [{ type: 'text', text: `Subagente Pi iniciado na fila (#${config.activeIndex + 1} ${active.type}: ${active.id} → ${active.model}):\n${rpcReply.data?.text ?? JSON.stringify(rpcReply.data)}` }],
          details: rpcReply.data?.details ?? rpcReply.data,
        };
      }

      throw new Error(`Ação desconhecida: ${params.action}`);
    },
  });

  // Interactive TUI helper
  async function openInteractiveTui(ctx: ExtensionContext) {
    if (!ctx.hasUI) {
      const config = await loadQueueConfig();
      ctx.ui.notify(formatQueueList(config), 'info');
      return;
    }

    while (true) {
      const config = await refreshState(ctx);
      const itemLines = config.queue.map((item, idx) => formatQueueItem(item, idx, idx === config.activeIndex));
      const actions = [
        ...itemLines.map(line => `Selecionar ativo: ${line}`),
        '➕ Adicionar ACP subagent na fila',
        '➕ Adicionar Pi subagent (interno) na fila',
        '🔼 Mover item para cima',
        '🔽 Mover item para baixo',
        '🗑️ Remover item da fila',
        '🧪 Simular erro (400/429/500) e testar failover',
        '📋 Ver últimos logs de erro',
        '🔄 Restaurar fila padrão de teste',
        'Fechar',
      ];

      const choice = await ctx.ui.select('Fila de Subagentes (ACP + Pi Interno)', actions);
      if (!choice || choice === 'Fechar') break;

      if (choice.startsWith('Selecionar ativo: ')) {
        const idx = actions.indexOf(choice);
        if (idx >= 0 && idx < config.queue.length) {
          config.activeIndex = idx;
          await saveQueueConfig(config);
          await refreshState(ctx);
          ctx.ui.notify(`Ativo definido para #${idx + 1}: ${config.queue[idx].type}: ${config.queue[idx].id}`, 'info');
        }
        continue;
      }

      if (choice === '➕ Adicionar ACP subagent na fila') {
        const acpCfg = await loadAcpConfig().catch(() => ({ agents: { opencode: { harness: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' } } }));
        const presets = Object.entries(acpCfg.agents).map(([name, a]: [string, any]) => `${name} (${a.model ?? 'padrão do harness'})`);
        presets.push('Digitar manualmente...');
        const picked = await ctx.ui.select('Escolha o ACP Subagent', presets);
        if (!picked) continue;
        let spec: string | undefined;
        if (picked === 'Digitar manualmente...') {
          const manual = await ctx.ui.input('Informe <agent> ou <model> (ex: deepseek-v4.1-flash-free)', 'deepseek-v4.1-flash-free');
          if (manual?.trim()) spec = `acp-subagent: ${manual.trim()}`;
        } else {
          const agentName = picked.split(' ')[0];
          const agentObj = (acpCfg.agents as any)[agentName];
          const modelInput = await ctx.ui.input(`Modelo para ${agentName}`, agentObj?.model ?? '');
          const entry = await parseQueueEntry({
            type: 'acp-subagent',
            agent: agentName,
            model: modelInput?.trim() || agentObj?.model,
            id: modelInput?.trim() ? modelInput.trim().replace(new RegExp(`^${agentName}/`), '') : agentName,
          });
          config.queue.push(entry);
          await saveQueueConfig(config);
          await refreshState(ctx);
          ctx.ui.notify(`Adicionado: ${entry.type}: ${entry.id}`, 'info');
          continue;
        }
        if (spec) {
          const entry = await parseQueueEntry(spec);
          config.queue.push(entry);
          await saveQueueConfig(config);
          await refreshState(ctx);
          ctx.ui.notify(`Adicionado: ${entry.type}: ${entry.id}`, 'info');
        }
        continue;
      }

      if (choice === '➕ Adicionar Pi subagent (interno) na fila') {
        const candidates: string[] = ['kgw/kilo-auto/free'];
        try {
          const mData = JSON.parse(await readFile(getModelsJsonPath(), 'utf8'));
          for (const [prov, pObj] of Object.entries(mData?.providers ?? {}) as [string, any][]) {
            for (const m of (pObj?.models ?? []).slice(0, 15)) {
              if (m?.id && !candidates.includes(`${prov}/${m.id}`)) candidates.push(`${prov}/${m.id}`);
            }
          }
        } catch {}
        candidates.unshift('Digitar manualmente...');
        const picked = await ctx.ui.select('Escolha o modelo Pi interno', candidates);
        if (!picked) continue;
        let modelSpec = picked;
        if (picked === 'Digitar manualmente...') {
          const manual = await ctx.ui.input('Modelo Pi (ex: kgw/kilo-auto/free ou 9router/cx/gpt-5.6-luna)', 'kgw/kilo-auto/free');
          if (!manual?.trim()) continue;
          modelSpec = manual.trim();
        }
        const entry = await parseQueueEntry({ type: 'pi', id: modelSpec });
        config.queue.push(entry);
        await saveQueueConfig(config);
        await refreshState(ctx);
        ctx.ui.notify(`Adicionado: ${entry.type}: ${entry.id} (${entry.model})`, 'info');
        continue;
      }

      if (choice === '🔼 Mover item para cima' || choice === '🔽 Mover item para baixo') {
        const dir = choice.includes('cima') ? -1 : 1;
        const targetChoice = await ctx.ui.select('Qual item deseja mover?', itemLines);
        if (!targetChoice) continue;
        const fromIdx = itemLines.indexOf(targetChoice);
        const toIdx = fromIdx + dir;
        if (fromIdx < 0 || toIdx < 0 || toIdx >= config.queue.length) {
          ctx.ui.notify('Movimento fora dos limites da fila.', 'warning');
          continue;
        }
        const activeItem = config.queue[config.activeIndex];
        const [moved] = config.queue.splice(fromIdx, 1);
        config.queue.splice(toIdx, 0, moved);
        config.activeIndex = Math.max(0, config.queue.indexOf(activeItem));
        await saveQueueConfig(config);
        await refreshState(ctx);
        continue;
      }

      if (choice === '🗑️ Remover item da fila') {
        if (config.queue.length <= 1) {
          ctx.ui.notify('A fila deve ter no mínimo 1 item.', 'warning');
          continue;
        }
        const targetChoice = await ctx.ui.select('Qual item deseja remover?', itemLines);
        if (!targetChoice) continue;
        const idx = itemLines.indexOf(targetChoice);
        if (idx >= 0) {
          config.queue.splice(idx, 1);
          if (config.activeIndex >= config.queue.length) config.activeIndex = 0;
          await saveQueueConfig(config);
          await refreshState(ctx);
        }
        continue;
      }

      if (choice === '🧪 Simular erro (400/429/500) e testar failover') {
        const codeChoice = await ctx.ui.select('Selecione o código de erro para simular', ['429 Too Many Requests', '400 Bad Request', '500 Internal Server Error']);
        if (!codeChoice) continue;
        const errorInfo = detectFailureError(codeChoice, 'failed')!;
        const active = config.queue[config.activeIndex];
        await handleDetectedError({
          failedItem: active,
          errorInfo,
          runId: `sim-${Date.now()}`,
          task: 'Simulação de teste via TUI',
          notifyTurn: false,
        });
        continue;
      }

      if (choice === '📋 Ver últimos logs de erro') {
        try {
          const raw = await readFile(getQueueLogPath(), 'utf8');
          const tailLines = raw.trim().split('\n').slice(-10).join('\n');
          ctx.ui.notify(`Últimos registros (${getQueueLogPath()}):\n${tailLines}`, 'info');
        } catch {
          ctx.ui.notify(`Log vazio (${getQueueLogPath()}).`, 'info');
        }
        continue;
      }

      if (choice === '🔄 Restaurar fila padrão de teste') {
        await saveQueueConfig({ activeIndex: 0, queue: structuredClone(DEFAULT_QUEUE) });
        await refreshState(ctx);
        ctx.ui.notify('Fila restaurada para o padrão de teste.', 'info');
        continue;
      }
    }
  }

  pi.registerCommand('subagents-queue', {
    description: 'Gerenciar fila de subagentes (TUI/config): [tui|list|next|select <n>|add <spec>|remove <n>|move <de> <para>|failover [400|429|500]|logs|reset]',
    handler: async (args, ctx) => {
      uiContext = ctx;
      const trimmed = args.trim();
      const [sub = ctx.hasUI ? 'tui' : 'list', ...rest] = trimmed ? trimmed.split(/\s+/) : [];

      try {
        if (sub === 'tui') {
          await openInteractiveTui(ctx);
          return;
        }
        if (sub === 'list' || sub === 'status') {
          const config = await refreshState(ctx);
          const msg = `Fila de Subagentes (${getQueueConfigPath()}):\n${formatQueueList(config)}\nLog: ${getQueueLogPath()}`;
          ctx.ui.notify(msg, 'info');
          return;
        }
        if (sub === 'next') {
          const config = await loadQueueConfig();
          config.activeIndex = (config.activeIndex + 1) % config.queue.length;
          const saved = await saveQueueConfig(config);
          await refreshState(ctx);
          const active = saved.queue[saved.activeIndex];
          ctx.ui.notify(`Fila avançada para #${saved.activeIndex + 1}: ${active.type}: ${active.id}`, 'info');
          return;
        }
        if (sub === 'select' && rest[0]) {
          const config = await loadQueueConfig();
          const idx = Number(rest[0]) - 1;
          if (!Number.isInteger(idx) || idx < 0 || idx >= config.queue.length) {
            throw new Error(`Índice inválido. Use 1..${config.queue.length}`);
          }
          config.activeIndex = idx;
          const saved = await saveQueueConfig(config);
          await refreshState(ctx);
          ctx.ui.notify(`Selecionado #${idx + 1}: ${saved.queue[idx].type}: ${saved.queue[idx].id}`, 'info');
          return;
        }
        if (sub === 'add' && rest.length) {
          const config = await loadQueueConfig();
          const entry = await parseQueueEntry(rest.join(' '));
          config.queue.push(entry);
          const saved = await saveQueueConfig(config);
          await refreshState(ctx);
          ctx.ui.notify(`Adicionado!\n${formatQueueList(saved)}`, 'info');
          return;
        }
        if (sub === 'remove' && rest[0]) {
          const config = await loadQueueConfig();
          if (config.queue.length <= 1) throw new Error('A fila não pode ficar vazia.');
          const idx = Number(rest[0]) - 1;
          if (!Number.isInteger(idx) || idx < 0 || idx >= config.queue.length) {
            throw new Error(`Índice inválido. Use 1..${config.queue.length}`);
          }
          config.queue.splice(idx, 1);
          if (config.activeIndex >= config.queue.length) config.activeIndex = 0;
          const saved = await saveQueueConfig(config);
          await refreshState(ctx);
          ctx.ui.notify(`Removido!\n${formatQueueList(saved)}`, 'info');
          return;
        }
        if (sub === 'move' && rest.length >= 2) {
          const config = await loadQueueConfig();
          const from = Number(rest[0]) - 1;
          const to = Number(rest[1]) - 1;
          if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= config.queue.length || to >= config.queue.length) {
            throw new Error(`Índices inválidos. Use 1..${config.queue.length}`);
          }
          const activeItem = config.queue[config.activeIndex];
          const [moved] = config.queue.splice(from, 1);
          config.queue.splice(to, 0, moved);
          config.activeIndex = Math.max(0, config.queue.indexOf(activeItem));
          const saved = await saveQueueConfig(config);
          await refreshState(ctx);
          ctx.ui.notify(`Fila reordenada!\n${formatQueueList(saved)}`, 'info');
          return;
        }
        if (sub === 'failover') {
          const status = rest[0] || '429';
          const reason = rest.slice(1).join(' ') || `Simulated HTTP ${status} error`;
          const errorInfo = detectFailureError(`${status} ${reason}`, 'failed') ?? { matched: true, code: Number(status) || 500, reason };
          const config = await loadQueueConfig();
          const active = config.queue[config.activeIndex];
          await handleDetectedError({
            failedItem: active,
            errorInfo,
            runId: `cmd-failover-${Date.now()}`,
            task: 'Teste de failover manual via comando /subagents-queue failover',
            notifyTurn: false,
          });
          return;
        }
        if (sub === 'logs') {
          try {
            const raw = await readFile(getQueueLogPath(), 'utf8');
            ctx.ui.notify(raw.trim().split('\n').slice(-15).join('\n') || 'Log vazio.', 'info');
          } catch {
            ctx.ui.notify(`Nenhum log encontrado em ${getQueueLogPath()}`, 'info');
          }
          return;
        }
        if (sub === 'reset') {
          const saved = await saveQueueConfig({ activeIndex: 0, queue: structuredClone(DEFAULT_QUEUE) });
          await refreshState(ctx);
          ctx.ui.notify(`Fila restaurada para o padrão:\n${formatQueueList(saved)}`, 'info');
          return;
        }
        throw new Error('Uso: /subagents-queue [tui|list|next|select <n>|add <tipo: id>|remove <n>|move <de> <para>|failover [400|429|500]|logs|reset]');
      } catch (err) {
        ctx.ui.notify((err as Error).message, 'error');
      }
    },
  });
}
