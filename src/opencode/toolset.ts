/** Request-local optimization only. Never grants a permission or modifies global tools. */
export type ToolContext = { readonly sessionID: string; tools: Record<string, unknown> };
export type ToolProfile = { send: boolean; receive: boolean };
const allowed = new Set(['synapse_submit','synapse_message','synapse_inbox']);
function size(tools: Record<string,unknown>): number | undefined {
  try { return JSON.stringify(tools).length; } catch { return undefined; }
}
export function filterLeanTools(event: ToolContext, profile: ToolProfile) {
  if (!event.tools || typeof event.tools !== 'object' || Array.isArray(event.tools)) return {filterStatus:'invalid_shape' as const};
  const keys=Object.keys(event.tools);
  const required=['synapse_submit',...(profile.send?['synapse_message']:[]),...(profile.receive?['synapse_inbox']:[])];
  const before=size(event.tools);
  // Code Mode or another plugin may hide direct tools. Do not remove the only route to a required tool.
  if(required.some(key=>!Object.hasOwn(event.tools,key)||!event.tools[key])) return {filterStatus:'required_missing' as const,toolsBefore:keys.length,toolsAfter:keys.length,schemaCharsBefore:before,schemaCharsAfter:before};
  // Preflight avoids a partially filtered registry on an immutable host object.
  if(keys.some(key=>!allowed.has(key)&&Object.getOwnPropertyDescriptor(event.tools,key)?.configurable!==true)) return {filterStatus:'immutable' as const,toolsBefore:keys.length,toolsAfter:keys.length,schemaCharsBefore:before,schemaCharsAfter:before};
  for(const key of keys) if(!allowed.has(key)) delete event.tools[key];
  return {filterStatus:'applied' as const,toolsBefore:keys.length,toolsAfter:Object.keys(event.tools).length,schemaCharsBefore:before,schemaCharsAfter:size(event.tools)};
}

/** Older hosts may not expose this hook. No global fallback or permission changes. */
export async function installToolHook(sessions: unknown, filter: (event: ToolContext)=>void): Promise<boolean> {
  const api=sessions as {hook?: (name: 'context', callback:(event:ToolContext)=>void)=>Promise<unknown>} | undefined;
  try {
    if(typeof api?.hook !== 'function') return false;
    await api.hook('context',filter);
    return true;
  } catch {return false;}
}
