import { randomUUID, createHash } from 'node:crypto';

export const TIERS = ['read', 'write', 'exec', 'screen', 'network'];
export const POLICY_MODES = ['deny','ask','allow'];
export const RISK_LEVELS = ['read','write','exec','screen','network','send'];
export const DEFAULT_POLICY_MODES = Object.freeze({read:'allow',write:'ask',exec:'ask',screen:'ask',network:'ask'});
const SECRET = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/g;
export function redact(value) {
  if (typeof value === 'string') return value.replace(SECRET, '[REDACTED]').replace(/([\w.+-]+)@([\w.-]+\.[A-Za-z]{2,})/g, '[EMAIL]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [/password|token|secret|authorization|api.?key/i.test(k) ? k : k, /password|token|secret|authorization|api.?key/i.test(k) ? '[REDACTED]' : redact(v)]));
  return value;
}
export function wrapUntrusted(source, text) { return `<untrusted_content source="${String(source).replace(/["<>]/g, '')}">\n${redact(text)}\n</untrusted_content>`; }
export function decidePolicy({ tier, tainted = false, mode = 'ask', risk = 'read', context = {} }) {
  const typed = { type:'policy.decision.v1', tier, risk, mode, tainted:Boolean(tainted), context:Object.freeze({agentId:context.agentId||null,workspace:context.workspace||null,sessionId:context.sessionId||null}) };
  const result = (decision,reason) => Object.freeze({...typed,decision,reason,allowed:decision==='allow',requiresApproval:decision==='ask'});
  if (!TIERS.includes(tier)) return result('deny', 'Unknown permission tier');
  if (!POLICY_MODES.includes(mode)) return result('deny', 'Unknown policy mode');
  if (!RISK_LEVELS.includes(risk)) return result('deny', 'Unknown action risk');
  if (mode === 'deny') return result('deny', 'Denied by policy');
  if (tainted && ['write','exec','screen','network'].includes(tier)) return result('ask', 'Untrusted content was present in the latest model context');
  if (risk === 'send') return result('ask', 'Sending always requires explicit approval');
  if (mode === 'allow') return result('allow', `${tier} access is allowed by policy`);
  return result('ask', `Approval required for ${tier}`);
}
function validateModeMap(value,label){
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label} must be an object`);
  const result={};
  for(const [key,mode] of Object.entries(value)){
    if(!TIERS.includes(key)||!POLICY_MODES.includes(mode))throw new Error(`${label} contains an invalid tier or mode`);
    result[key]=mode;
  }
  return result;
}
function validateToolModes(value,label){
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label} must be an object`);
  const result={};
  for(const [tool,mode] of Object.entries(value)){
    if(!/^[a-z][a-z0-9_.-]{0,100}$/i.test(tool)||!POLICY_MODES.includes(mode))throw new Error(`${label} contains an invalid tool or mode`);
    result[tool]=mode;
  }
  return result;
}
export function validatePolicyConfig(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Policy configuration must be an object');
  const config={tiers:validateModeMap(value.tiers,'tiers'),tools:validateToolModes(value.tools,'tools'),workspaces:{}};
  if(value.workspaces!==undefined){
    if(!value.workspaces||typeof value.workspaces!=='object'||Array.isArray(value.workspaces))throw new Error('workspaces must be an object');
    for(const [workspace,entry] of Object.entries(value.workspaces)){
      if(!workspace||workspace.length>1000||!entry||typeof entry!=='object'||Array.isArray(entry))throw new Error('workspaces contains an invalid entry');
      config.workspaces[workspace]={tiers:validateModeMap(entry.tiers,'workspace tiers'),tools:validateToolModes(entry.tools,'workspace tools')};
    }
  }
  return config;
}
export function resolvePolicyMode(configValue,tier,toolId,workspace){
  const sessionTools=configValue?.sessionTools||{},config=validatePolicyConfig(configValue||{}),workspacePolicy=config.workspaces[workspace]||{};
  const base=workspacePolicy.tools?.[toolId]||config.tools[toolId]||workspacePolicy.tiers?.[tier]||config.tiers[tier]||DEFAULT_POLICY_MODES[tier]||'deny';
  if(base==='deny')return 'deny';
  return sessionTools[toolId]==='allow'?'allow':base;
}
export function routeTask(task, agents, tools, skills = []) {
  const tokens = String(task).toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  const score = (row) => {
    const words = `${row.name ?? ''} ${row.description ?? ''} ${(row.tags ?? []).join(' ')}`.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    const set = new Set(words);
    return tokens.reduce((n, t) => n + (set.has(t) ? 1 : 0), 0) / Math.sqrt(Math.max(1, set.size));
  };
  const chosen = [...agents].sort((a,b) => score(b)-score(a))[0] ?? { id: 'general', name: 'General' };
  const ranked = [...tools].map(t => ({...t, score: score(t)})).sort((a,b) => b.score-a.score).filter(t=>t.score>0).slice(0,15);
  const selectedSkills = [...skills].map(s=>({...s, score:score(s)})).sort((a,b)=>b.score-a.score).filter(s=>s.score>0).slice(0,3);
  return { agent: chosen.id, skills: selectedSkills.map(s=>s.id), tools: ranked.map(t=>t.id), confidence: ranked.length ? Math.min(.95,.35+ranked[0].score) : .35, backend:'bm25', candidates: ranked.slice(0,5).map(({id,score})=>({id,score})), reason: 'Lexical retrieval over the local catalog' };
}
export function makeId(prefix) { return `${prefix}_${randomUUID()}`; }
export function hashArgs(args) { return createHash('sha256').update(JSON.stringify(args)).digest('hex'); }
