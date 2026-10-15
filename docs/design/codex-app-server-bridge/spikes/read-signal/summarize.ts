// Prints a compact timeline of one probe log: the events that matter for read marking.
// Usage: bun summarize.ts <log-file>
import { readFileSync } from 'node:fs';

const lines = readFileSync(process.argv[2]!, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

let deltaRun = 0;

for (const { ms, dir, m } of lines) {
  const p = m.params ?? {};
  const method: string | undefined = m.method;

  if (method === 'item/agentMessage/delta') {
    deltaRun++;
    continue;
  }

  if (deltaRun > 0) {
    console.log(`${ms}\t  (${deltaRun} agentMessage deltas)`);

    deltaRun = 0;
  }

  if (dir === 'out') {
    const text = p.input?.[0]?.text;

    console.log(
      `${ms}\t> ${method} ${p.clientUserMessageId ?? ''} ${text ? JSON.stringify(text) : ''}`,
    );

    continue;
  }

  if (!method) {
    const r = m.result ?? {};

    console.log(
      `${ms}\t< result id=${m.id} ${r.turn ? `turn=${r.turn.id} ${r.turn.status}` : ''}${m.error ? JSON.stringify(m.error) : ''}`,
    );

    continue;
  }

  if (
    /delta|tokenUsage|rateLimits|mcpServer|skills|configWarning|account/.test(method) &&
    method !== 'thread/tokenUsage/updated'
  )
    continue;

  let detail = '';

  if (method.startsWith('item/')) {
    const it = p.item ?? {};

    detail = `${it.type}${it.clientId ? ` clientId=${it.clientId}` : ''}${it.phase ? ` phase=${it.phase}` : ''}`;

    if (it.type === 'agentMessage' && method === 'item/completed')
      detail += ` text=${JSON.stringify(String(it.text).slice(-40))}`;

    if (it.type === 'userMessage')
      detail += ` text=${JSON.stringify(JSON.stringify(it.content).slice(0, 60))}`;
  } else if (method === 'rawResponseItem/completed') {
    const it = p.item ?? {};
    const txt = JSON.stringify(it.content ?? it.arguments ?? it.action ?? '').slice(-50);

    detail = `${it.type} role=${it.role ?? ''} ${txt}`;
  } else if (method === 'rawResponse/completed') {
    detail = `responseId=${p.responseId} input=${p.usage?.inputTokens ?? p.usage?.input_tokens ?? JSON.stringify(p.usage)?.slice(0, 80)}`;
  } else if (method === 'thread/tokenUsage/updated') {
    detail = JSON.stringify(p.tokenUsage?.last ?? p).slice(0, 90);
  } else if (method.startsWith('turn/')) {
    detail = `${p.turn?.id ?? p.turnId ?? ''} ${p.turn?.status ?? ''}`;
  } else if (p.threadId) {
    detail = `thread=${p.threadId}`;
  }

  console.log(`${ms}\t< ${method} ${detail}`);
}
