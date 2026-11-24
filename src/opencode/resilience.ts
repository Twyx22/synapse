import { blocksGraph, classifyProviderError, object, ProviderSessionError, type ProviderCategory, type FailureSource } from '../core/provider.ts';
export type RetryEvent={sessionID:string;error:unknown;attempt:number;decision:{retry:boolean;delay?:number}};
export type { FailureSource } from "../core/provider.ts";
/** Only currently managed sessions can affect the circuit. Weak keys scope it to one execution. */
export class ProviderResilience {
  private readonly sessions=new Map<string,{signal:AbortSignal;failure?:ProviderCategory;source?:FailureSource}>();
  private readonly circuits=new WeakMap<AbortSignal,ProviderCategory>();
  private readonly observe:(sessionID:string,category:ProviderCategory,source:FailureSource)=>void;
  constructor(observe:(sessionID:string,category:ProviderCategory,source:FailureSource)=>void=()=>{}){this.observe=observe;}
  open(id:string,signal:AbortSignal){this.sessions.set(id,{signal});}
  close(id:string){this.sessions.delete(id);}
  check(signal:AbortSignal){if(this.circuits.has(signal))throw new ProviderSessionError('provider_circuit_open','circuit');}
  failure(id:string){return this.sessions.get(id)?.failure;}
  source(id:string){return this.sessions.get(id)?.source;}
  trip(signal:AbortSignal,category:ProviderCategory){if(blocksGraph(category))this.circuits.set(signal,category);}
  mark(id:string,category:ProviderCategory,source:FailureSource){
    const state=this.sessions.get(id);if(!state)return;
    if(state.failure===category)return;
    // Prefer a typed provider failure to a generic terminal marker.
    if(state.failure && (category==='session_failed'||category==='session_interrupted'))return;
    state.failure=category;state.source=source;
    this.trip(state.signal,category);
    this.observe(id,category,source);
  }
  retry(event:RetryEvent){
    if(!this.sessions.has(event.sessionID))return;
    const category=classifyProviderError(event.error);
    // Do not authorize extra attempts. Only veto hard limits and invalid requests;
    // temporary transport errors keep the host's existing bounded policy.
    if(category && (blocksGraph(category)||category==='provider_invalid_request')){
      event.decision={retry:false};this.mark(event.sessionID,category,'retry_hook');
    }
  }
  event(event:unknown){
    const row=object(event),data=object(row?.data);
    if(typeof data?.sessionID!=='string'||!this.sessions.has(data.sessionID))return;
    if(row?.type==='session.execution.failed')this.mark(data.sessionID,classifyProviderError(data.error)??'session_failed','terminal_event');
    if(row?.type==='session.execution.interrupted')this.mark(data.sessionID,'session_interrupted','terminal_event');
  }
}
export async function installRetryHook(sessions:unknown,handler:(event:RetryEvent)=>void){
  const api=sessions as {hook?:(name:'retry',callback:(event:RetryEvent)=>void)=>Promise<unknown>}|undefined;
  try{if(typeof api?.hook!=='function')return false;await api.hook('retry',handler);return true;}catch{return false;}
}
/** Per-plugin stream; cancellation is tied to the plugin lifecycle, not user activity. */
export function subscribeFailures(events:unknown,handler:(event:unknown)=>void,onError:()=>void){
  const api=events as {subscribe?:(options:{types:string[];signal:AbortSignal})=>AsyncIterable<unknown>}|undefined;
  if(typeof api?.subscribe!=='function')return undefined;
  const controller=new AbortController();
  void (async()=>{try{for await(const event of api.subscribe!({types:['session.execution.failed','session.execution.interrupted'],signal:controller.signal})){if(controller.signal.aborted)break;handler(event);}}catch{if(!controller.signal.aborted)onError();}})();
  return ()=>controller.abort();
}
