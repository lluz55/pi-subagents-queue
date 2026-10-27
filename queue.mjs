import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { loadConfig as loadAcpConfig } from '../acp-subagents/config.mjs';

export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR || resolve(homedir(), '.pi/agent');
export const getQueueConfigPath = () => process.env.PI_SUBAGENTS_QUEUE_CONFIG || resolve(getAgentDir(), 'subagents-queue.json');
export const getQueueLogPath = () => process.env.PI_SUBAGENTS_QUEUE_LOG || resolve(getAgentDir(), 'subagents-queue.log');
export const getModelsJsonPath = () => resolve(getAgentDir(), 'models.json');
export const getSettingsJsonPath = () => resolve(getAgentDir(), 'settings.json');
export const agentDir = getAgentDir();
export const queueConfigPath = getQueueConfigPath();
export const queueLogPath = getQueueLogPath();
export const modelsJsonPath = getModelsJsonPath();
export const settingsJsonPath = getSettingsJsonPath();

export const DEFAULT_QUEUE = [
  {
    type: 'acp-subagent',
    id: 'deepseek-v4.1-flash-free',
    agent: 'opencode',
    model: 'opencode/deepseek-v4.1-flash-free',
  },
  {
    type: 'pi',
    id: 'kgw/kilo-auto/free',
    agent: 'delegate',
    model: '9router/kgw/kilo-auto/free',
  },
];

const ERROR_CODE_PATTERNS = [
  /\b(400|401|402|403|404|408|409|413|422|429|500|502|503|504|529)\b/,
  /\[(\d{3})\]/,
  /status(?:\s+code)?[\s:=]+(\d{3})/i,
  /http(?:\/\d(?:\.\d)?)?\s+(\d{3})/i,
];

const ERROR_TEXT_PATTERNS = [
  { code: 429, regex: /rate[_\s-]?limit|too many requests|quota|usage limit reached|free usage limit|throttl|exhausted|capacity/i },
  { code: 400, regex: /bad request|invalid[_\s-]?request|value unavailable|model unavailable|unknown model|context_length_exceeded|unsupported|needs non-empty agent and task|use only tasks at the top level|must contain 1[–-]4 assignments/i },
  { code: 401, regex: /unauthorized|authentication required|invalid api key|unauthenticated/i },
  { code: 403, regex: /forbidden|permission denied|access denied/i },
  { code: 404, regex: /not found|page not found|no such model/i },
  { code: 408, regex: /timed[_\s-]?out|timeout|deadline exceeded/i },
  { code: 500, regex: /internal error|internal server error|-32603|overloaded|bad gateway|service unavailable|gateway timeout|acp stopped|process exited/i },
];

export function detectFailureError(textOrError, status = '') {
  const raw = String(textOrError ?? '').trim();
  const normStatus = String(status ?? '').toLowerCase();
  if (!raw && normStatus !== 'failed' && normStatus !== 'timed_out' && normStatus !== 'error') {
    return null;
  }
  if (normStatus === 'cancelled' || normStatus === 'stopped') {
    return null;
  }
  if (/session was replaced or reloaded|extension session was replaced|workflow stopped because/i.test(raw)) {
    return null;
  }
  // Local ACP task-shape validation is not an agent availability failure.
  if (/^ACP:\s*(?:each task|task) needs non-empty agent and task strings\b/i.test(raw)) {
    return null;
  }
  for (const pattern of ERROR_CODE_PATTERNS) {
    const match = raw.match(pattern);
    if (match) {
      const code = Number(match[1]);
      if (code >= 400 && code <= 599) {
        return { matched: true, code, reason: raw || `HTTP ${code}` };
      }
    }
  }
  for (const { code, regex } of ERROR_TEXT_PATTERNS) {
    if (regex.test(raw)) {
      return { matched: true, code, reason: raw };
    }
  }
  if (normStatus === 'timed_out') {
    return { matched: true, code: 408, reason: raw || 'Execution timed out' };
  }
  if (normStatus === 'failed' || normStatus === 'error') {
    return { matched: true, code: 500, reason: raw || `Run status: ${normStatus}` };
  }
  return null;
}

export function normalizeItemType(rawType) {
  const t = String(rawType ?? '').trim().toLowerCase();
  if (['acp', 'acp-subagent', 'acp-subagents', 'acp_subagent'].includes(t)) return 'acp-subagent';
  if (['pi', 'pi-subagent', 'pi-subagents', 'internal', 'subagent'].includes(t)) return 'pi';
  throw new Error(`Tipo de subagente inválido "${rawType}". Use "acp-subagent" ou "pi".`);
}

export async function resolvePiModel(rawId, sPath = getSettingsJsonPath(), mPath = getModelsJsonPath()) {
  const id = String(rawId ?? '').trim();
  if (!id) throw new Error('Identificador de modelo Pi vazio.');
  let defaultProvider = '9router';
  try {
    const settings = JSON.parse(await readFile(sPath, 'utf8'));
    if (typeof settings?.defaultProvider === 'string' && settings.defaultProvider.trim()) {
      defaultProvider = settings.defaultProvider.trim();
    }
  } catch {}

  try {
    const modelsData = JSON.parse(await readFile(mPath, 'utf8'));
    const providers = modelsData?.providers ?? {};
    const firstSegment = id.split('/')[0];
    if (Object.hasOwn(providers, firstSegment)) {
      return id;
    }
    for (const [provName, prov] of Object.entries(providers)) {
      const list = Array.isArray(prov?.models) ? prov.models : [];
      if (list.some(m => m?.id === id)) {
        return `${provName}/${id}`;
      }
    }
  } catch {}

  if (id.startsWith(`${defaultProvider}/`)) return id;
  return `${defaultProvider}/${id}`;
}

export async function parseQueueEntry(entryInput, options = {}) {
  const acpConfig = options.acpConfig ?? await loadAcpConfig().catch(() => ({ agents: { opencode: { harness: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' } } }));

  if (typeof entryInput === 'string') {
    const cleaned = entryInput.trim().replace(/^\d+[\.\)\-]\s*/, '');
    const match = cleaned.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/);
    if (!match) {
      throw new Error(`Formato inválido "${entryInput}". Use "<acp-subagent|pi>: <id/model>".`);
    }
    return parseQueueEntry({ type: match[1], id: match[2].trim() }, { ...options, acpConfig });
  }

  if (!entryInput || typeof entryInput !== 'object' || Array.isArray(entryInput)) {
    throw new Error('Item da fila deve ser um objeto ou string "<tipo>: <id>".');
  }

  const type = normalizeItemType(entryInput.type);
  const rawId = String(entryInput.id ?? entryInput.model ?? entryInput.agent ?? '').trim();
  if (!rawId) throw new Error('Item da fila requer "id" ou "model".');

  if (type === 'acp-subagent') {
    const agents = acpConfig?.agents ?? {};
    let agent = typeof entryInput.agent === 'string' && entryInput.agent.trim() ? entryInput.agent.trim() : undefined;
    let model = typeof entryInput.model === 'string' && entryInput.model.trim() ? entryInput.model.trim() : undefined;

    if (!agent) {
      if (Object.hasOwn(agents, rawId)) {
        agent = rawId;
        model ??= agents[rawId]?.model;
      } else {
        const prefix = rawId.split('/')[0];
        if (Object.hasOwn(agents, prefix)) {
          agent = prefix;
          model ??= rawId;
        } else {
          const matchingAgent = Object.entries(agents).find(([, a]) => {
            const m = String(a?.model ?? '');
            return m === rawId || m.endsWith(`/${rawId}`) || m.includes(rawId);
          });
          if (matchingAgent) {
            agent = matchingAgent[0];
            model ??= matchingAgent[1]?.model ?? rawId;
          } else {
            agent = Object.hasOwn(agents, 'opencode') ? 'opencode' : (Object.keys(agents)[0] ?? 'opencode');
            model ??= rawId.includes('/') || rawId.includes(':') ? rawId : `${agent}/${rawId}`;
          }
        }
      }
    } else if (!model) {
      if (rawId !== agent) {
        model = rawId.includes('/') || rawId.includes(':') ? rawId : `${agent}/${rawId}`;
      } else {
        model = agents[agent]?.model;
      }
    }

    const displayId = entryInput.id ? String(entryInput.id).trim() : (model ? model.replace(new RegExp(`^${agent}/`), '') : agent);
    return {
      type: 'acp-subagent',
      id: displayId,
      agent,
      ...(model ? { model } : {}),
    };
  }

  // type === 'pi'
  let agent = typeof entryInput.agent === 'string' && entryInput.agent.trim() ? entryInput.agent.trim() : 'delegate';
  let modelInput = typeof entryInput.model === 'string' && entryInput.model.trim() ? entryInput.model.trim() : rawId;
  if (rawId.includes('@')) {
    const [rolePart, modelPart] = rawId.split('@');
    if (rolePart.trim() && modelPart.trim()) {
      agent = rolePart.trim();
      modelInput = modelPart.trim();
    }
  }
  const model = await resolvePiModel(modelInput, options.settingsPath, options.modelsPath);
  const displayId = entryInput.id ? String(entryInput.id).trim() : modelInput;
  return {
    type: 'pi',
    id: displayId,
    agent,
    model,
  };
}

let writeMutex = Promise.resolve();

export async function loadQueueConfig(path = getQueueConfigPath(), options = {}) {
  let raw = null;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Erro ao ler configuração da fila (${path}): ${error.message}`);
    }
  }

  const acpConfig = options.acpConfig ?? await loadAcpConfig().catch(() => ({ agents: { opencode: { harness: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' } } }));
  const rawQueue = Array.isArray(raw?.queue) && raw.queue.length > 0 ? raw.queue : DEFAULT_QUEUE;
  const queue = [];
  for (const item of rawQueue) {
    queue.push(await parseQueueEntry(item, { ...options, acpConfig }));
  }

  let activeIndex = Number.isInteger(raw?.activeIndex) ? raw.activeIndex : 0;
  if (activeIndex < 0 || activeIndex >= queue.length) activeIndex = 0;

  return { activeIndex, queue };
}

export function saveQueueConfig(config, path = getQueueConfigPath()) {
  const op = writeMutex.then(async () => {
    if (!config || !Array.isArray(config.queue) || config.queue.length === 0) {
      throw new Error('A fila de subagentes deve conter pelo menos 1 item.');
    }
    const normalizedQueue = [];
    const acpConfig = await loadAcpConfig().catch(() => ({ agents: { opencode: { harness: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' } } }));
    for (const item of config.queue) {
      normalizedQueue.push(await parseQueueEntry(item, { acpConfig }));
    }
    let activeIndex = Number.isInteger(config.activeIndex) ? config.activeIndex : 0;
    if (activeIndex < 0 || activeIndex >= normalizedQueue.length) activeIndex = 0;

    const payload = { activeIndex, queue: normalizedQueue };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }
    return payload;
  });
  writeMutex = op.catch(() => {});
  return op;
}

export async function appendQueueLog(entry, logFile = getQueueLogPath()) {
  await mkdir(dirname(logFile), { recursive: true, mode: 0o700 });
  const record = {
    timestamp: new Date().toISOString(),
    ...entry,
  };
  await appendFile(logFile, JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

export async function advanceQueueOnFailure({ failedItem, errorInfo, runId, task, configPath = getQueueConfigPath(), logFile = getQueueLogPath() } = {}) {
  const config = await loadQueueConfig(configPath);
  const currentIndex = config.activeIndex;
  const currentItem = config.queue[currentIndex];
  const matchedIdx = failedItem
    ? config.queue.findIndex(item => item.type === failedItem.type && (item.id === failedItem.id || item.model === failedItem.model || item.agent === failedItem.agent))
    : currentIndex;

  const baseIndex = matchedIdx >= 0 ? matchedIdx : currentIndex;
  const nextIndex = (baseIndex + 1) % config.queue.length;
  const nextItem = config.queue[nextIndex];
  const rotated = config.queue.length > 1 && nextIndex !== config.activeIndex;

  config.activeIndex = nextIndex;
  await saveQueueConfig(config, configPath);

  const logEntry = await appendQueueLog({
    event: 'subagent_error_failover',
    code: errorInfo?.code ?? 500,
    reason: errorInfo?.reason ?? 'Unknown error',
    runId: runId ?? null,
    taskPreview: task ? String(task).slice(0, 200) : undefined,
    failedAgent: failedItem ?? currentItem,
    previousIndex: baseIndex,
    nextIndex,
    nextAgent: nextItem,
    rotated,
  }, logFile);

  return {
    config,
    previousIndex: baseIndex,
    failedAgent: failedItem ?? currentItem,
    nextIndex,
    nextAgent: nextItem,
    rotated,
    logEntry,
  };
}

export function formatQueueItem(item, index, isActive = false) {
  const marker = isActive ? '▶' : ' ';
  const num = index !== undefined ? `${index + 1}. ` : '';
  const badge = item.type === 'acp-subagent' ? 'acp-subagent' : 'pi';
  const detail = item.type === 'acp-subagent'
    ? `(harness/agent: ${item.agent}${item.model ? `, model: ${item.model}` : ''})`
    : `(role: ${item.agent ?? 'delegate'}, model: ${item.model})`;
  return `${marker} ${num}${badge}: ${item.id} ${detail}`;
}

export function formatQueueList(config) {
  return config.queue
    .map((item, idx) => formatQueueItem(item, idx, idx === config.activeIndex))
    .join('\n');
}
