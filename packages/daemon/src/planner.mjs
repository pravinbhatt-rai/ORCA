export function buildPlan(task, routedAgent, availableAgents) {
  const ids=new Set(availableAgents.map(a=>a.id));
  const has=(id)=>ids.has(id);
  const website=/website|web app|e-?commerce|portfolio|landing page|frontend/i.test(task);
  const coding=/build|create|implement|code|fix|refactor|website|web app|e-?commerce|portfolio/i.test(task);
  const research=/research|compare|requirements|plan|analy[sz]e|evaluate/i.test(task);
  const items=[];
  if(website&&has('researcher'))items.push({key:'requirements',title:'Analyze product needs and user-facing requirements',owner:'researcher',depends:[]});
  if(coding&&has('coder'))items.push({key:'implementation',title:'Implement the requested workspace change',owner:'coder',depends:website&&has('researcher')?['requirements']:[]});
  if(research&&!website&&has('researcher'))items.push({key:'research',title:'Gather evidence and summarize findings',owner:'researcher',depends:[]});
  if(items.length&&has('reviewer'))items.push({key:'review',title:'Review the worker result for correctness and risks',owner:'reviewer',depends:[items.at(-1).key]});
  if(!items.length)items.push({key:'primary',title:'Complete the requested task',owner:has(routedAgent)?routedAgent:'general',depends:[]});
  const selected=[...new Set(items.map(x=>x.owner))];
  const done=new Set(),parallelGroups=[];while(done.size<items.length){const ready=items.filter(x=>!done.has(x.key)&&x.depends.every(d=>done.has(d)));if(!ready.length)break;parallelGroups.push(ready.map(x=>x.key));ready.forEach(x=>done.add(x.key));}
  const fallback=has('general')?'general':selected[0];
  return {supervisor:has('planner')?'planner':fallback,items,selected,parallelGroups,risk:/send|delete|publish|purchase|payment/i.test(task)?'high':coding?'write':'read',explanation:`Selected ${selected.join(', ')} using task-category matches and the available agent catalog.`,fallback};
}

export function validatePlanOutput(text, availableAgents, fallbackAgent='general') {
  let raw;try{raw=JSON.parse(text);}catch{return null;}
  const available=new Set(availableAgents.map(a=>typeof a==='string'?a:a.id));
  if(!Array.isArray(raw.items)||raw.items.length<1||raw.items.length>8)return null;
  const fallback=available.has(fallbackAgent)?fallbackAgent:[...available][0];
  const keys=new Set();const items=[];
  for(const item of raw.items){
    if(!item||typeof item.key!=='string'||!/^[a-z0-9_-]{1,50}$/i.test(item.key)||keys.has(item.key)||typeof item.title!=='string'||!item.title.trim()||item.title.length>500||!available.has(item.owner))return null;
    if(!Array.isArray(item.depends)||item.depends.length>8||item.depends.some(x=>typeof x!=='string')||new Set(item.depends).size!==item.depends.length)return null;
    keys.add(item.key);items.push({key:item.key,title:item.title.trim(),owner:item.owner,depends:[...item.depends]});
  }
  if(items.some(x=>x.depends.some(d=>!keys.has(d)||d===x.key)))return null;
  const done=new Set(),parallelGroups=[];while(done.size<items.length){const ready=items.filter(x=>!done.has(x.key)&&x.depends.every(d=>done.has(d)));if(!ready.length)return null;parallelGroups.push(ready.map(x=>x.key));ready.forEach(x=>done.add(x.key));}
  return {supervisor:available.has('planner')?'planner':fallback,items,selected:[...new Set(items.map(x=>x.owner))],parallelGroups,risk:raw.risk==='high'?'high':raw.risk==='write'?'write':'read',explanation:typeof raw.explanation==='string'?raw.explanation.slice(0,1000):'LLM-generated plan constrained to available agents.',fallback,planner:'llm'};
}
