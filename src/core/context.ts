import type { AgentContext, TeamMessage } from './types.ts';

/** Reduce optional message duplication without truncating dependency results or task instructions.
 * Direct inbound messages are mandatory context; the optional budget does not apply to them.
 * The persistent inbox remains unchanged and can be queried using the ordinary tool. */
export function selectTeamContext(input: AgentContext, optionalBudget = 8000) {
  const direct: TeamMessage[] = [], optional: TeamMessage[] = [];
  for (const message of input.messages) {
    if (message.to === input.task.id && message.from !== input.task.id) direct.push(message);
    else if (message.to === 'all' && message.from !== input.task.id) optional.push(message);
  }
  const line = (m: TeamMessage) => `[${m.type}] ${m.from} -> ${m.to}: ${JSON.stringify(m.body)}`;
  const included = new Set(direct.map(line));
  const selected = [...direct];
  let remaining = optionalBudget;
  for (const m of optional.reverse()) {
    const text = line(m);
    if (included.has(text) || text.length + 1 > remaining) continue;
    remaining -= text.length + 1;
    included.add(text);
    selected.push(m);
  }
  const chosen = new Set(selected.map(m=>m.id));
  const rendered = input.messages.filter(m=>chosen.has(m.id)).map(line).join('\n');
  const omitted = input.messages.length - selected.length;
  return {text: rendered || 'None', inputMessages:input.messages.length, includedMessages:selected.length,
    omittedMessages:omitted, directMessages:direct.length, optionalBudget, messageChars:rendered.length,
    dependencyChars:input.dependencies.reduce((n,d)=>n+d.result.length,0)};
}
