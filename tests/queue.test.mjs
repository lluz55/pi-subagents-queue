import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  advanceQueueOnFailure,
  DEFAULT_QUEUE,
  detectFailureError,
  formatQueueList,
  loadQueueConfig,
  parseQueueEntry,
  saveQueueConfig,
} from '../queue.mjs';

const require = createRequire(import.meta.url);
let createJiti;
try { ({ createJiti } = require(process.env.PI_TEST_JITI ?? '/home/lluz/.pi/agent/npm/node_modules/jiti')); }
catch {}

test('parseQueueEntry resolves test queue items (1. acp-subagent: deepseek-v4.1-flash-free, 2. pi: kgw/kilo-auto/free)', async () => {
  const first = await parseQueueEntry('1. acp-subagent: deepseek-v4.1-flash-free');
  assert.equal(first.type, 'acp-subagent');
  assert.equal(first.id, 'deepseek-v4.1-flash-free');
  assert.equal(first.agent, 'opencode');
  assert.equal(first.model, 'opencode/deepseek-v4.1-flash-free');

  const second = await parseQueueEntry('2. pi: kgw/kilo-auto/free');
  assert.equal(second.type, 'pi');
  assert.equal(second.id, 'kgw/kilo-auto/free');
  assert.equal(second.agent, 'delegate');
  assert.equal(second.model, '9router/kgw/kilo-auto/free');
});

test('detectFailureError captures 400, 429, 500, quota limits, and timeouts', () => {
  assert.equal(detectFailureError('HTTP 400 Bad Request')?.code, 400);
  assert.equal(detectFailureError('Error [429]: Rate limit reached')?.code, 429);
  assert.equal(detectFailureError('Free usage limit reached. Free models work in OpenCode (-32603)')?.code, 429);
  assert.equal(detectFailureError('ACP value unavailable: model=foo')?.code, 400);
  assert.equal(detectFailureError('Internal Server Error 500')?.code, 500);
  assert.equal(detectFailureError('Service unavailable 503')?.code, 503);
  assert.equal(detectFailureError('', 'timed_out')?.code, 408);
  const invalidTask = 'ACP: each task needs non-empty agent and task strings, with optional cwd string. Example: {"tasks":[{"agent":"opencode","task":"oi"}]}';
  const invalidSingleTask = 'ACP: task needs non-empty agent and task strings.';
  assert.equal(detectFailureError(invalidTask, 'failed'), null, 'local ACP argument validation must not advance queue');
  assert.equal(detectFailureError(invalidSingleTask, 'failed'), null, 'singular local ACP validation must not advance queue');
  assert.equal(detectFailureError('HTTP 503: service unavailable; ACP: task needs non-empty agent and task strings')?.code, 503);
  assert.equal(detectFailureError('ACP: use only tasks at the top level; put agent, task and cwd inside each item.')?.code, 400);
  assert.equal(detectFailureError('ACP: tasks must contain 1–4 assignments.')?.code, 400);
  const reloadMessage = 'Workflow stopped because the extension session was replaced or reloaded. Async children that were still running keep running, and finished children are kept.';
  assert.equal(detectFailureError(reloadMessage, 'failed'), null);
  assert.equal(detectFailureError(reloadMessage, 'error'), null);
  assert.equal(detectFailureError('', 'completed'), null);
  assert.equal(detectFailureError('', 'cancelled'), null);
});

test('loadQueueConfig, saveQueueConfig, and advanceQueueOnFailure write logs and switch active agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subagents-queue-test-'));
  const cfgPath = join(dir, 'queue.json');
  const logPath = join(dir, 'queue.log');

  try {
    const initial = await loadQueueConfig(cfgPath);
    assert.equal(initial.activeIndex, 0);
    assert.equal(initial.queue.length, 2);
    assert.equal(initial.queue[0].type, 'acp-subagent');
    assert.equal(initial.queue[0].id, 'deepseek-v4.1-flash-free');
    assert.equal(initial.queue[1].type, 'pi');
    assert.equal(initial.queue[1].id, 'kgw/kilo-auto/free');

    // Trigger 429 error on agent #1 (acp-subagent: deepseek-v4.1-flash-free)
    const errorInfo = detectFailureError('429 Too Many Requests: Free usage limit reached', 'failed');
    const step1 = await advanceQueueOnFailure({
      failedItem: initial.queue[0],
      errorInfo,
      runId: 'run-test-429',
      task: 'Implement feature X',
      configPath: cfgPath,
      logFile: logPath,
    });

    assert.equal(step1.previousIndex, 0);
    assert.equal(step1.nextIndex, 1);
    assert.equal(step1.nextAgent.type, 'pi');
    assert.equal(step1.nextAgent.id, 'kgw/kilo-auto/free');
    assert.equal(step1.nextAgent.model, '9router/kgw/kilo-auto/free');

    // Verify persisted config updated activeIndex to 1
    const afterStep1 = await loadQueueConfig(cfgPath);
    assert.equal(afterStep1.activeIndex, 1);

    // Verify log entry written
    const logLines = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(logLines.length, 1);
    assert.equal(logLines[0].code, 429);
    assert.equal(logLines[0].failedAgent.id, 'deepseek-v4.1-flash-free');
    assert.equal(logLines[0].nextAgent.id, 'kgw/kilo-auto/free');

    // Trigger 500 error on agent #2 (pi: kgw/kilo-auto/free) -> wraps around to #1
    const step2 = await advanceQueueOnFailure({
      failedItem: afterStep1.queue[1],
      errorInfo: detectFailureError('500 Internal Server Error', 'failed'),
      runId: 'run-test-500',
      task: 'Continue feature X',
      configPath: cfgPath,
      logFile: logPath,
    });
    assert.equal(step2.previousIndex, 1);
    assert.equal(step2.nextIndex, 0);
    assert.equal(step2.nextAgent.type, 'acp-subagent');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extension lifecycle: tool_call interception, event failover, TUI commands, and subagent_queue tool', { skip: !createJiti }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subagents-queue-ext-'));
  process.env.PI_SUBAGENTS_QUEUE_CONFIG = join(dir, 'subagents-queue.json');
  process.env.PI_SUBAGENTS_QUEUE_LOG = join(dir, 'subagents-queue.log');

  const schema = join(dir, 'schema.mjs');
  const ui = join(dir, 'ui.mjs');
  await writeFile(schema, 'export const Type = new Proxy({}, { get: () => (...args) => ({ args }) });');
  await writeFile(ui, 'export class Text { constructor(text) { this.text = text; } }');

  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { '@earendil-works/pi-ai': schema, '@earendil-works/pi-tui': ui },
  });

  const { default: extension } = await jiti.import(fileURLToPath(new URL('../index.ts', import.meta.url)));

  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const eventListeners = new Map();
  const messages = [];
  const notices = [];
  let statusText;

  const pi = {
    registerMessageRenderer() {},
    registerTool: t => tools.set(t.name, t),
    registerCommand: (n, c) => commands.set(n, c),
    on: (name, fn) => handlers.set(name, fn),
    sendMessage: (msg, opts) => messages.push({ ...msg, options: opts }),
    events: {
      on: (ch, fn) => {
        const list = eventListeners.get(ch) ?? [];
        list.push(fn);
        eventListeners.set(ch, list);
        return () => {};
      },
      emit: async (ch, payload) => {
        for (const fn of eventListeners.get(ch) ?? []) await fn(payload);
      },
    },
  };

  extension(pi);

  let selectQueue = [];
  const ctx = {
    cwd: dir,
    hasUI: true,
    tools: [{ name: 'acp_subagent' }, { name: 'subagent' }],
    executeTool: async (name, args) => ({
      isError: false,
      result: { content: [{ type: 'text', text: `Executed ${name}: ${JSON.stringify(args)}` }], details: { args } },
    }),
    ui: {
      setStatus: (_k, val) => { statusText = val; },
      notify: (msg, level) => notices.push({ msg, level }),
      select: async (_title, options) => {
        const pick = selectQueue.shift();
        if (pick === undefined) return 'Fechar';
        if (typeof pick === 'number') return options[pick];
        return options.find(o => o.includes(pick)) ?? 'Fechar';
      },
      input: async (_title, placeholder) => placeholder,
    },
  };

  try {
    await handlers.get('session_start')({}, ctx);
    assert.match(statusText, /Fila\[1\/2\]: acp:deepseek-v4\.1-flash-free/);

    // 1. Test tool_call hook when active is #1 (acp-subagent: deepseek-v4.1-flash-free)
    const acpInput = { tasks: [{ agent: 'auto', task: 'check files' }] };
    await handlers.get('tool_call')({ toolName: 'acp_subagent', input: acpInput }, ctx);
    assert.equal(acpInput.tasks[0].agent, 'opencode');
    assert.equal(acpInput.tasks[0].model, 'opencode/deepseek-v4.1-flash-free');

    // 2. Test subagent_queue delegate when #1 is active
    const del1 = await tools.get('subagent_queue').execute('call-1', { action: 'delegate', task: 'test task 1' }, undefined, undefined, ctx);
    assert.equal(del1.details.args.tasks[0].agent, 'opencode');
    assert.equal(del1.details.args.tasks[0].model, 'opencode/deepseek-v4.1-flash-free');

    // 3. Emit ACP failure event (HTTP 429) -> should log & advance queue to #2 (pi: kgw/kilo-auto/free) and notify parent LLM to decide full retry vs checkpoint
    await pi.events.emit('acp-subagents:event', {
      event: 'failed',
      run: {
        id: 'acp-run-fail-1',
        agent: 'opencode',
        model: 'opencode/deepseek-v4.1-flash-free',
        status: 'failed',
        error: '429 Too Many Requests: rate limit exceeded',
        task: 'Implement module A and B',
        text: 'Completed module A, module B pending.',
      },
    });

    assert.match(statusText, /Fila\[2\/2\]: pi:kgw\/kilo-auto\/free/);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].options.triggerTurn, true);
    assert.match(messages[0].content, /SUBAGENTS-QUEUE FAILOVER/);
    assert.match(messages[0].content, /1\. Reenviar a MESMA tarefa/);
    assert.match(messages[0].content, /2\. Resumir e enviar um CHECKPOINT/);
    assert.match(messages[0].content, /Completed module A, module B pending/);

    // Exact reload completion is ignored by the async-complete handler.
    await pi.events.emit('subagent:async-complete', {
      success: false,
      state: 'failed',
      summary: 'Workflow stopped because the extension session was replaced or reloaded. Async children that were still running keep running, and finished children are kept.',
      id: 'reload-run',
    });
    assert.match(statusText, /Fila\[2\/2\]: pi:kgw\/kilo-auto\/free/);
    assert.equal(messages.length, 1);

    // 4. Test tool_call hook when active is #2 (pi: kgw/kilo-auto/free)
    const piInput = { agent: 'worker', task: 'finish module B' };
    await handlers.get('tool_call')({ toolName: 'subagent', input: piInput }, ctx);
    assert.equal(piInput.agent, 'worker');
    assert.equal(piInput.model, '9router/kgw/kilo-auto/free');

    // 5. Test interactive TUI via /subagents-queue tui (select #1 again)
    selectQueue = [0, 'Fechar']; // 0 selects item #1 in the TUI list
    await commands.get('subagents-queue').handler('tui', ctx);
    assert.match(statusText, /Fila\[1\/2\]: acp:deepseek-v4\.1-flash-free/);

    // 6. Verify log file contains the 429 record
    const logContent = await readFile(process.env.PI_SUBAGENTS_QUEUE_LOG, 'utf8');
    const logRecord = JSON.parse(logContent.trim().split('\n')[0]);
    assert.equal(logRecord.code, 429);
    assert.equal(logRecord.failedAgent.id, 'deepseek-v4.1-flash-free');
    assert.equal(logRecord.nextAgent.id, 'kgw/kilo-auto/free');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
