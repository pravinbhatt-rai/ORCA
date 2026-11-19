const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
let currentPage = "canvas",
  cached = {},
  activeStream = null,
  canvasEventSources = new Map(),
  canvasRefreshTimer = 0;
const titles = {
  canvas: "Canvas",
  overview: "Overview",
  runs: "Runs",
  agents: "Agents",
  skills: "Skills",
  tools: "Tools & MCP",
  connectors: "Connectors",
  memory: "Memory",
  tasks: "Task board",
  approvals: "Approvals",
  router: "Router analytics",
  lifecycle: "Lifecycle inbox",
  updates: "Updates",
  audit: "Audit log",
  settings: "Settings",
};
async function api(path, opts = {}) {
  const headers = {
    "content-type": "application/json",
    ...(opts.headers || {}),
  };
  const r = await fetch("/api" + path, { ...opts, headers });
  const data = await r.json();
  if (r.status === 401) {
    throw Error("Session expired");
  }
  if (!r.ok)
    throw Error(
      data.error?.message || data.error || `Request failed (${r.status})`,
    );
  return data;
}
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2300);
}
function esc(x = "") {
  return String(x).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
async function init() {
  try {
    const status = await api("/status");
    $(".provider b").textContent = `${status.provider} provider`;
    $(".provider small").textContent =
      status.provider === "mock"
        ? "Offline · no API key"
        : "Configured · provider active";
    $("#app").classList.remove("hidden");
    await render();
  } catch (err) {
    $("#content").innerHTML = `<div class="panel">${esc(err.message)}</div>`;
  }
}
$("#refresh").onclick = () => render();
$("#content").addEventListener("click", handleAction);
$("#nav").onclick = (e) => {
  const b = e.target.closest("[data-page]");
  if (b) go(b.dataset.page);
};
$$("[data-page]").forEach((b) =>
  b.addEventListener("click", () => go(b.dataset.page)),
);
function go(page) {
  if (page !== "canvas") closeCanvasStreams();
  currentPage = page;
  $$(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.page === page),
  );
  $("#crumb-title").textContent = titles[page] || page;
  render();
}
const head = (title, sub, buttons = "") =>
  `<div class="page-head"><div><p class="eyebrow">${esc(title === "Overview" ? "SYSTEM STATUS" : "ORCHESTRATION")}</p><h1>${esc(title)}</h1><p class="subtitle">${sub}</p></div><div class="head-buttons">${buttons}</div></div>`;
const button = (text, action, kind = "") =>
  `<button class="button ${kind}" data-action="${action}">${text}</button>`;
const fmtDate = (s) =>
  s
    ? new Date(
        s.replace(" ", "T") + (s.includes("Z") ? "" : "Z"),
      ).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
const pill = (s) =>
  `<span class="status-pill ${s === "pending" || s === "doing" ? "warn" : s === "denied" || s === "blocked" ? "red" : ""}">${esc(s || "active")}</span>`;
async function render() {
  $("#crumb-title").textContent = titles[currentPage];
  try {
    await (
      {
        canvas: canvas,
        overview: overview,
        runs: runs,
        agents: agents,
        skills: skills,
        tools: tools,
        connectors: connectors,
        memory: memory,
        tasks: tasks,
        approvals: approvals,
        router: router,
        lifecycle: lifecycle,
        updates: updates,
        audit: audit,
        settings: settings,
      }[currentPage] || overview
    )();
  } catch (e) {
    $("#content").innerHTML = `<div class="panel">${esc(e.message)}</div>`;
  }
}
async function canvas() {
  const d = await api("/canvas"); cached.canvas = d;
  const active = d.runs.filter(r => ["queued", "planning", "running", "waiting_for_approval"].includes(r.status));
  const stream = active.map(r => { const items=(r.plan&&r.plan.items)||[]; const links=items.flatMap(item=>(item.depends||[]).map(dep=>{const source=items.find(x=>x.key===dep);return '<span class="dependency-link">'+esc(source?source.owner:dep)+' · '+esc(dep)+' <b>→</b> '+esc(item.owner)+' · '+esc(item.key)+'</span>'})).join(''); return '<section class="flow-run" data-run-id="'+esc(r.id)+'"><header><b>' + esc(r.task) + '</b><span>' + pill(r.status) + ' <button class="table-action" data-action="inspect-run" data-id="' + esc(r.id) + '">Open trace</button></span></header><div class="flow-nodes">' + r.nodes.map(n => '<button class="canvas-node ' + (n.supervisor ? 'supervisor' : 'worker') + '" data-key="' + esc(n.subtaskKey||'') + '" data-hover-node="' + esc(n.id) + '" data-run="' + esc(r.id) + '"><span class="node-status ' + esc(n.status) + '"></span><b>' + esc(n.agent) + '</b><small>' + esc(n.title) + '</small><i>' + esc(n.status) + ' · ' + n.messages.length + ' messages · ' + n.tools.length + ' tools · ' + (n.artifacts||[]).length + ' files</i></button>').join('') + '</div>' + (links?'<div class="dependency-links"><b>Dependencies</b>'+links+'</div>':'')+'</section>'; }).join('') || '<div class="empty">No active work. Start a task or run a saved workflow.</div>';
  const workflows = d.workflows.map(w => '<div class="workflow-row"><div><b>' + esc(w.name) + '</b><small>' + esc(w.description || 'Saved local workflow') + ' · ' + w.definition.items.length + ' agents</small></div><button class="button tiny" data-action="workflow-edit" data-id="' + esc(w.id) + '">Edit</button><button class="button tiny" data-action="run-workflow" data-id="' + esc(w.id) + '">Run</button><button class="table-action" data-action="delete-workflow" data-id="' + esc(w.id) + '">Delete</button></div>').join('') || '<p class="panel-note">No saved workflows yet.</p>';
  const agentRows = d.agents.map(a => '<label class="agent-model"><span>' + esc(a.name) + ' <small>' + esc(a.category) + '</small></span><select data-agent-model="' + esc(a.id) + '" class="select"><option value="">Automatic routing</option>' + d.providers.filter(p => p.enabled).map(p => '<option value="' + esc(p.id) + '" ' + (a.provider_id === p.id ? 'selected' : '') + '>' + esc(p.name) + ' · ' + esc(p.model) + '</option>').join('') + '</select></label>').join('');
  const actions = '<button class="button quiet" data-action="save-workflow">Save workflow</button><button class="button primary" data-action="new-run">New task</button>';
  $("#content").innerHTML = head("Canvas", 'Live local workspace · ' + esc(d.workspace) + ' · ' + active.length + ' active parent runs', actions) + '<div class="canvas-layout"><aside class="panel canvas-rail"><h3>Agent routing</h3><p class="panel-note">Choose a model per agent, or leave automatic to route by task specialty.</p>' + agentRows + '<div id="canvas-inspector" class="canvas-inspector"><div class="panel-note">Hover an active agent to inspect its activity.</div></div></aside><div><div class="panel canvas-board"><div class="panel-head"><span class="panel-title">Live agent activity</span><span class="panel-note">Hover a worker to inspect tools, providers and messages</span></div>' + stream + '</div><div class="panel workflow-shelf"><div class="panel-head"><span class="panel-title">Saved workflows</span><span class="panel-note">Stored on this device</span></div>' + workflows + '</div></div></div>';
  drawDependencyEdges();
  $$("[data-agent-model]").forEach(sel => sel.onchange = async () => { try { await api('/agents/' + sel.dataset.agentModel + '/model', {method:'PUT', body:JSON.stringify({provider_id:sel.value || null})}); toast('Agent routing saved'); } catch(e) { toast(e.message); } });
  syncCanvasStreams(active);
  clearTimeout(window.canvasPoll); window.canvasPoll = setTimeout(() => { if(currentPage === 'canvas') render(); }, 12000);
}
function closeCanvasStreams(){clearTimeout(window.canvasPoll);clearTimeout(canvasRefreshTimer);for(const source of canvasEventSources.values())source.close();canvasEventSources.clear();}
function syncCanvasStreams(active){
  const ids=new Set(active.map(run=>run.id));
  for(const [id,source] of canvasEventSources)if(!ids.has(id)){source.close();canvasEventSources.delete(id);}
  const eventNames=['run.queued','run.created','plan.created','subtask.created','subtask.completed','agent.started','agent.tool_call','agent.tool_result','agent.completed','agent.blocked','agent.message','worker.event','budget.updated','blackboard.updated','approval.requested','approval.approved','approval.denied','run.completed','run.failed','run.cancel_requested'];
  for(const run of active){if(canvasEventSources.has(run.id))continue;const source=new EventSource('/api/runs/'+encodeURIComponent(run.id)+'/stream'),refresh=()=>{if(currentPage!=='canvas'||canvasRefreshTimer)return;canvasRefreshTimer=setTimeout(()=>{canvasRefreshTimer=0;if(currentPage==='canvas')render();},180);};for(const name of eventNames)source.addEventListener(name,refresh);source.onerror=()=>{};canvasEventSources.set(run.id,source);}
}
function drawDependencyEdges(){
  $$('.flow-run').forEach(section=>{const run=cached.canvas.runs.find(x=>x.id===section.dataset.runId),items=run?.plan?.items||[],row=section.querySelector('.flow-nodes');if(!row)return;row.querySelector('.dependency-graph')?.remove();const cards=[...row.querySelectorAll('.canvas-node[data-key]')].filter(x=>x.dataset.key);if(!items.some(x=>(x.depends||[]).length)||!cards.length)return;const width=Math.max(row.scrollWidth,row.clientWidth),height=row.scrollHeight+28,svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('class','dependency-graph');svg.setAttribute('width',width);svg.setAttribute('height',height);svg.setAttribute('viewBox','0 0 '+width+' '+height);svg.innerHTML='<defs><marker id="dependency-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#9fbc8d"/></marker></defs>';for(const item of items)for(const dependency of item.depends||[]){const from=cards.find(x=>x.dataset.key===dependency),to=cards.find(x=>x.dataset.key===item.key);if(!from||!to)continue;const x1=from.offsetLeft+from.offsetWidth/2,y1=from.offsetTop+from.offsetHeight,x2=to.offsetLeft+to.offsetWidth/2,y2=to.offsetTop+to.offsetHeight,lane=Math.max(y1,y2)+15,path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M '+x1+' '+y1+' L '+x1+' '+lane+' L '+x2+' '+lane+' L '+x2+' '+y2);path.setAttribute('class','dependency-edge');path.setAttribute('marker-end','url(#dependency-arrow)');svg.append(path);}row.append(svg);});
}
function showCanvasInspector(runId, nodeId) {
  const run = cached.canvas && cached.canvas.runs.find(x => x.id === runId), node = run && run.nodes.find(x => x.id === nodeId), el = $("#canvas-inspector");
  if (!node || !el) return;
  const agent = cached.canvas.agents.find(x => x.id === node.agent), provider = cached.canvas.providers.find(x => x.id === node.providerId) || (agent && agent.provider), providerName=provider?.name||node.providerName||'Automatic routing',model=provider?.model||node.model||'profile selected at runtime';
  const usedTools=node.tools.map(id=>{const spec=(cached.canvas.tools||[]).find(x=>x.id===id);return `<div class="message-chip"><b>${esc(spec?.name||id)}</b><small>${esc(spec?.source||'runtime')} · ${spec?.server_id?'MCP server '+esc(spec.server_id):'built-in'} · ${esc(spec?.risk||'unknown risk')}</small></div>`}).join('');
  el.innerHTML = '<h3>' + esc(node.agent) + '</h3><p class="panel-note">' + esc(agent ? agent.category : 'agent') + ' · ' + esc(node.status) + '</p><div class="settings-row"><strong>Provider / model</strong><small>' + esc(providerName) + ' · ' + esc(model) + '</small></div><h4>Tools &amp; plugins used</h4>' + (usedTools||'<small class="panel-note">None recorded yet</small>') + '<h4>Workspace files</h4>' + ((node.artifacts||[]).map(a=>'<div class="message-chip"><b>'+esc(a.path)+'</b><small>'+esc(a.tool)+' · '+a.bytes+' bytes'+(a.alreadyApplied?' · recovered effect':'')+'</small></div>').join('')||'<small class="panel-note">No file writes recorded.</small>') + '<h4>Messages</h4>' + (node.messages.slice(-5).map(m => '<div class="message-chip"><b>' + esc(m.from_agent) + ' → ' + esc(m.to_agent) + '</b><small>' + esc(m.content) + '</small></div>').join('') || '<small class="panel-note">No agent messages yet.</small>') + '<button class="button tiny" data-action="inspect-run" data-id="' + esc(run.id) + '">Open full trace</button>';
}
$("#content").addEventListener('mouseover', e => { const n = e.target.closest('[data-hover-node]'); if(n) showCanvasInspector(n.dataset.run, n.dataset.hoverNode); });
async function overview() {
  const d = await api("/overview");
  $("#run-count").textContent = d.counts.runs || "";
  $("#approval-count").textContent = d.pendingApprovals || "";
  const stats = [
    ["Active runs", d.counts.runs, "Recorded local executions"],
    ["Agent library", d.counts.agents, "Available specialist profiles"],
    ["Skills indexed", d.counts.skills, "Progressive disclosure catalog"],
    ["Pending approvals", d.pendingApprovals, "Actions waiting for review"],
  ];
  const bars = Array.from({ length: 7 }, (_, i) => ({
    label: ["M", "T", "W", "T", "F", "S", "S"][i],
    v: (d.activity || [])[i]?.count || 0,
  }));
  const max = Math.max(1, ...bars.map((x) => x.v));
  $("#content").innerHTML =
    head(
      "Overview",
      "A clear view of the local agent system and its current activity.",
      button("New run", "new-run", "primary"),
    ) +
    `<div class="stat-grid">${stats.map((x) => `<div class="stat-card"><div class="stat-title">${x[0]}</div><div class="stat-value">${x[1] || 0}</div><div class="stat-foot">${x[2]}</div></div>`).join("")}</div><div class="overview-grid"><div class="panel"><div class="panel-head"><span class="panel-title">Run activity</span><span class="panel-note">Last 7 days · local records</span></div><div class="activity">${bars.map((x) => `<div class="bar-col"><div class="bar" style="height:${Math.max(3, (x.v / max) * 75)}%"></div><span>${x.label}</span></div>`).join("")}</div></div><div class="panel"><div class="panel-head"><span class="panel-title">System health</span><span class="status-pill">OPERATIONAL</span></div>${[
      ["LLM provider", "Mock · offline ready"],
      ["Router", "BM25 · lexical retrieval"],
      ["Storage", "SQLite · WAL mode"],
      ["Network scope", "Loopback only"],
    ]
      .map(
        (x) =>
          `<div class="health-row"><span class="health-key">${x[0]}</span><span class="health-value">${x[1]}</span></div>`,
      )
      .join(
        "",
      )}</div></div><div class="section-title">Quick access</div><div class="quick-grid"><div class="quick-card" data-jump="runs"><strong>Inspect recent runs ↗</strong><span>Read the routing decision and recorded context.</span></div><div class="quick-card" data-jump="approvals"><strong>Review approvals ↗</strong><span>Approve or deny requested actions with exact args.</span></div><div class="quick-card" data-jump="tasks"><strong>Move work forward ↗</strong><span>Update the shared task board.</span></div></div>`;
  $$("[data-jump]").forEach((x) => (x.onclick = () => go(x.dataset.jump)));
}
async function collection(name, columns, formatter, desc, actions = "") {
  const d = await api("/" + name);
  cached[name] = d.items;
  $("#content").innerHTML =
    head(titles[name] || name, desc, actions) +
    `<div class="toolbar"><div class="toolbar-left"><select class="select" id="filter"><option value="">All records</option><option>active</option><option>pending</option><option>completed</option></select></div><input class="search-input" id="search" placeholder="Search ${name}…" aria-label="Search ${name}"></div><div class="table-wrap"><table class="data-table"><thead><tr>${columns.map((c) => `<th>${c[0]}</th>`).join("")}</tr></thead><tbody id="tbody">${d.items.length ? d.items.map(formatter).join("") : `<tr><td colspan="${columns.length}" class="empty">No records yet</td></tr>`}</tbody></table></div><p class="panel-note" style="margin-top:10px">Showing ${d.items.length} of ${d.total} records · paginated API (maximum 250 rows)</p>`;
  const apply = () => {
    const q = $("#search").value.toLowerCase(),
      f = $("#filter").value;
    const rows = d.items.filter(
      (x) =>
        JSON.stringify(x).toLowerCase().includes(q) && (!f || x.status === f),
    );
    $("#tbody").innerHTML = rows.length
      ? rows.map(formatter).join("")
      : `<tr><td colspan="${columns.length}" class="empty">No matching records</td></tr>`;
  };
  $("#search").oninput = apply;
  $("#filter").onchange = apply;
}
async function runs() {
  const d = await api("/runs");
  const rows = d.items
    .map(
      (r) =>
        `<tr data-run="${esc(r.id)}"><td class="name-cell">${esc(r.task)}<div class="subcell">${esc(r.id)}</div></td><td>${esc(r.agent)}</td><td>${pill(r.status)}</td><td>${r.token_count || 0}</td><td>${fmtDate(r.created_at)}</td><td><button class="table-action" data-action="inspect-run" data-id="${esc(r.id)}">Inspect ↗</button>${['queued','planning','running','waiting_for_approval'].includes(r.status)?`<button class="table-action" data-action="cancel-run" data-id="${esc(r.id)}">Stop</button>`:''}</td></tr>`,
    )
    .join("");
  $("#content").innerHTML =
    head("Runs", "Agent runs, tool decisions, and model context.") +
    `<div class="toolbar"><span class="panel-note">${d.total} stored runs · provider selected from local environment</span><input class="search-input" id="search" placeholder="Search runs…"></div><div class="table-wrap"><table class="data-table"><thead><tr><th>REQUEST</th><th>AGENT</th><th>STATUS</th><th>TOKENS</th><th>STARTED</th><th></th></tr></thead><tbody id="tbody">${rows || '<tr><td colspan="6" class="empty">Start a run to see it here.</td></tr>'}</tbody></table></div>`;
  $("#search").oninput = () =>
    $$("#tbody tr").forEach(
      (r) =>
        (r.hidden = !r.textContent
          .toLowerCase()
          .includes($("#search").value.toLowerCase())),
    );
}
async function agents() {
  await collection(
    "agents",
    [
      ["AGENT", ""],
      ["CATEGORY", ""],
      ["STATE", ""],
      ["VERSION", ""],
      ["ACTIONS", ""],
    ],
    (a) =>
      `<tr><td class="name-cell">${esc(a.name)}<div class="subcell">${esc(a.description)}</div></td><td>${esc(a.category)}</td><td>${pill(a.status)}</td><td>v${a.version}</td><td><button class="table-action" data-action="agent-info" data-id="${esc(a.id)}">Details</button></td></tr>`,
    "Search and inspect the local agent catalog.",
    button("Create agent", "create-agent", "primary"),
  );
}
async function skills() {
  await collection(
    "skills",
    [
      ["SKILL", ""],
      ["PERMISSIONS", ""],
      ["STATE", ""],
      ["TRUST", ""],
      ["ACTIONS", ""],
    ],
    (s) =>
      `<tr><td class="name-cell">${esc(s.name)}<div class="subcell">${esc(s.description)}</div></td><td>${JSON.parse(
        s.permissions || "[]",
      )
        .map((x) => `<span class="badge">${esc(x)}</span>`)
        .join(
          " ",
        )}</td><td>${pill(s.status)}</td><td><span class="badge green">${s.pinned ? "PINNED" : "BUNDLED"}</span></td><td><button class="table-action" data-action="skill-info" data-id="${esc(s.id)}">Read</button></td></tr>`,
    "Instructions load only when selected by the router.",
    button("Create skill", "create-skill", "primary"),
  );
}
async function tools() {
  await collection(
    "tools",
    [
      ["TOOL", ""],
      ["RISK", ""],
      ["TAGS", ""],
      ["STATE", ""],
      ["ACTIONS", ""],
    ],
    (t) =>
      `<tr><td class="name-cell">${esc(t.name)}<div class="subcell">${esc(t.id)} · ${esc(t.description)}</div></td><td><span class="badge ${t.risk === "read" ? "green" : t.risk === "network" ? "red" : "amber"}">${esc(t.risk)}</span></td><td>${JSON.parse(
        t.tags || "[]",
      )
        .map((x) => `<span class="badge">${esc(x)}</span>`)
        .join(
          " ",
        )}</td><td>${t.availability === "executable" ? "executable" : "catalog only"}</td><td><span class="panel-note">policy gated</span></td></tr>`,
    "A local tool catalog with risk tiers and policy visibility.",
  );
  const servers = await api('/mcp/servers');
  $('#content').insertAdjacentHTML('beforeend', `<section class="panel" style="margin-top:14px"><div class="panel-head"><span class="panel-title">Custom MCP servers</span><button class="button primary" data-action="mcp-add">Add stdio server</button></div><p class="panel-note">Servers start untrusted. Review the command and grant each server only to the agents that need it.</p>${servers.items.map(s=>`<div class="settings-row"><div><strong>${esc(s.name)} <span class="badge ${s.trusted?'green':'amber'}">${s.trusted?'TRUSTED':'UNTRUSTED'}</span></strong><small>${esc(s.id)} · ${esc(s.command)} ${(s.args||[]).map(esc).join(' ')} · ${esc(s.status)}${s.last_error?' · '+esc(s.last_error):''} · agents: ${(s.allowed_agents||[]).map(esc).join(', ')||'none'}</small></div><span>${s.enabled&&s.trusted?`<button class="table-action" data-action="mcp-disconnect" data-id="${esc(s.id)}">Disconnect</button>`:`<button class="table-action" data-action="mcp-trust" data-id="${esc(s.id)}">Trust &amp; connect</button>`}<button class="table-action" data-action="mcp-delete" data-id="${esc(s.id)}">Remove</button></span></div>`).join('')||'<p class="panel-note">No MCP servers configured.</p>'}</section>`);
}
async function tasks() {
  const d = await api("/tasks");
  const statuses = ["todo", "doing", "done", "blocked"];
  $("#content").innerHTML =
    head(
      "Task board",
      "Work items shared across local agent runs.",
      button("New task", "create-task", "primary"),
    ) +
    `<div class="task-columns">${statuses
      .map(
        (s) =>
          `<div class="task-column"><header><span class="dot ${s === "done" ? "green" : ""}"></span><b>${s.toUpperCase()}</b><i>${d.items.filter((t) => t.status === s).length}</i></header>${d.items
            .filter((t) => t.status === s)
            .map(
              (t) =>
                `<div class="task-card"><strong>${esc(t.title)}</strong><small>Owner · ${esc(t.owner || "unassigned")}</small><select data-task="${esc(t.id)}"><option ${s === "todo" ? "selected" : ""} value="todo">To do</option><option ${s === "doing" ? "selected" : ""} value="doing">In progress</option><option ${s === "done" ? "selected" : ""} value="done">Done</option><option ${s === "blocked" ? "selected" : ""} value="blocked">Blocked</option></select></div>`,
            )
            .join("")}</div>`,
      )
      .join("")}</div>`;
  $$("[data-task]").forEach(
    (x) =>
      (x.onchange = async () => {
        await api("/tasks/" + x.dataset.task, {
          method: "POST",
          body: JSON.stringify({ status: x.value }),
        });
        toast("Task status updated");
        render();
      }),
  );
}
async function approvals() {
  await collection(
    "approvals",
    [
      ["ACTION", ""],
      ["REASON", ""],
      ["STATE", ""],
      ["REQUESTED", ""],
      ["REVIEW", ""],
    ],
    (a) =>
      `<tr><td class="name-cell">${esc(a.tool)}<div class="subcell">${esc(a.id)}</div></td><td>${esc(a.reason)}<div class="subcell">Exact arguments are bound to this approval.</div></td><td>${pill(a.status)}</td><td>${fmtDate(a.created_at)}</td><td>${a.status === "pending" ? `<button class="table-action" data-action="approval-detail" data-id="${esc(a.id)}">View args</button><button class="table-action" data-action="approval" data-id="${esc(a.id)}" data-hash="${esc(a.args_hash)}" data-status="approved" data-scope="once">Allow once</button><button class="table-action" data-action="approval" data-id="${esc(a.id)}" data-hash="${esc(a.args_hash)}" data-status="approved" data-scope="session">Allow this session</button><button class="table-action" data-action="approval" data-id="${esc(a.id)}" data-hash="${esc(a.args_hash)}" data-status="approved" data-scope="workspace">Always in workspace</button><button class="table-action" data-action="approval" data-id="${esc(a.id)}" data-hash="${esc(a.args_hash)}" data-status="denied">Deny</button>` : "—"}</td></tr>`,
    "Every side effect stays pending until reviewed.",
    button("Request approval", "request-approval", "quiet"),
  );
}
async function lifecycle() {
  await collection(
    "proposals",
    [
      ["PROPOSAL", ""],
      ["EVIDENCE", ""],
      ["STATE", ""],
      ["CREATED", ""],
      ["REVIEW", ""],
    ],
    (p) =>
      `<tr><td class="name-cell">${esc(p.title)}<div class="subcell">${esc(p.kind)} · ${esc(p.target)}</div></td><td>${esc(p.evidence)}</td><td>${pill(p.status)}</td><td>${fmtDate(p.created_at)}</td><td>${p.status === "pending" ? `<button class="table-action" data-action="proposal" data-id="${esc(p.id)}" data-status="approved">Approve</button><button class="table-action" data-action="proposal" data-id="${esc(p.id)}" data-status="rejected">Reject</button>` : "—"}</td></tr>`,
    "Evidence-backed proposals remain reviewable before any library change.",
  );
}
async function audit() {
  await collection(
    "audit",
    [
      ["EVENT", ""],
      ["ACTOR", ""],
      ["DETAILS", ""],
      ["TIME", ""],
    ],
    (a) =>
      `<tr><td class="name-cell">${esc(a.action)}</td><td>${esc(a.actor)}</td><td class="subcell">${esc(a.details)}</td><td>${fmtDate(a.created_at)}</td></tr>`,
    "Append-only local activity history.",
    button("Export JSON", "export", "quiet"),
  );
}
async function memory() {
  const d = await api("/memories");
  $("#content").innerHTML =
    head(
      "Memory explorer",
      "Local notes with scope and provenance.",
      button("Add memory", "add-memory", "primary"),
    ) +
    `<div class="toolbar"><span class="panel-note">Search stored memory</span><input class="search-input" id="search" placeholder="Search memories…"></div><div class="panel" id="memory-list">${d.items.length ? d.items.map((m) => `<div class="memory-card"><small>${esc(m.scope)} · ${esc(m.owner)} · ${fmtDate(m.created_at)}</small><p>${esc(m.text)}</p></div>`).join("") : '<div class="empty">No memory stored. Add a workspace note to make it available locally.</div>'}</div>`;
  $("#search").oninput = () =>
    $$(".memory-card").forEach(
      (x) =>
        (x.hidden = !x.textContent
          .toLowerCase()
          .includes($("#search").value.toLowerCase())),
    );
}
async function connectors() {
  $("#content").innerHTML =
    head("Connectors", "Connector inventory and access grants.") +
    `<div class="overview-grid">${[
      [
        "Gmail",
        "Not connected",
        "Search, read and draft. Sending requires exact-content approval.",
      ],
      [
        "Google Calendar",
        "Not connected",
        "Calendar access is not configured in this local build.",
      ],
      [
        "GitHub",
        "Not connected",
        "Connect an MCP server after reviewing its tools.",
      ],
      [
        "Slack",
        "Not connected",
        "Read selected channels; posting requires approval.",
      ],
    ]
      .map(
        (c, i) =>
          `<div class="panel"><div class="panel-head"><span class="panel-title">${c[0]}</span><span class="status-pill warn">${c[1]}</span></div><p class="panel-note">${c[2]}</p><div style="margin-top:15px">${i === 0 ? '<button class="button" data-action="connector-info">Setup instructions</button>' : '<button class="button" data-action="connector-info">Details</button>'}</div></div>`,
      )
      .join(
        "",
      )}</div><p class="panel-note" style="margin-top:15px">No credentials are bundled. Mail, web pages, and connector data must be treated as untrusted input.</p>`;
}
async function router() {
  $("#content").innerHTML =
    head(
      "Router analytics",
      "Inspect the current local retrieval backend and preview a route.",
    ) +
    `<div class="overview-grid"><div class="panel"><div class="panel-head"><span class="panel-title">Current backend</span><span class="status-pill">BM25 RETRIEVAL</span></div><div class="health-row"><span class="health-key">Selection mode</span><span class="health-value">Lexical term overlap</span></div><div class="health-row"><span class="health-key">Confidence</span><span class="health-value">Relative retrieval score</span></div><div class="health-row"><span class="health-key">Training model</span><span class="health-value">Not configured</span></div><div class="health-row"><span class="health-key">Catalog</span><span class="health-value">Live SQLite records</span></div></div><div class="panel"><div class="panel-title">Route preview</div><p class="panel-note">A task is matched to the current agent, skills, and top 15 tools.</p><textarea id="route-task" placeholder="Describe the work to route…" style="width:100%;min-height:80px;background:#111512;border:1px solid #363d37;color:#eee;padding:10px;margin-top:10px"></textarea><button class="button primary" id="route-btn" style="margin-top:8px">Preview route</button><div id="route-result"></div></div></div>`;
  $("#route-btn").onclick = async () => {
    try {
      const d = await api("/route", {
        method: "POST",
        body: JSON.stringify({ task: $("#route-task").value }),
      });
      $("#route-result").innerHTML =
        `<div class="context-segment">${esc(JSON.stringify(d, null, 2))}</div>`;
    } catch (e) {
      toast(e.message);
    }
  };
}
async function updates() {
  $("#content").innerHTML =
    head(
      "Updates",
      "Review component update policy. Model weights are never self-updated.",
    ) +
    `<div class="panel">${[
      ["Orchestra daemon", "0.1.0 · local build", "Notify"],
      ["Dashboard", "0.1.0 · local build", "Notify"],
      ["Router model", "No model installed", "Manual only"],
      ["Third-party tools", "None detected", "Off"],
    ]
      .map(
        (x) =>
          `<div class="settings-row"><div><strong>${x[0]}</strong><small>${x[1]}</small></div><span class="badge amber">${x[2]}</span></div>`,
      )
      .join(
        "",
      )}<p class="panel-note" style="margin-top:14px">A signed update manifest, signature verification, side-by-side install, and rollback flow are not configured in this build.</p></div>`;
}
async function settings() {
  const [s, p] = await Promise.all([api("/settings"), api("/providers")]);
  $("#content").innerHTML =
    head(
      "Settings",
      "Runtime preferences, provider profiles, and safety controls.",
      button("Add provider", "create-provider", "primary"),
    ) +
    `<div class="panel"><div class="panel-head"><span class="panel-title">Provider profiles</span><span class="panel-note">Secrets stored in the OS credential vault; values never returned by the API</span></div>${p.items.length ? p.items.map((x) => `<div class="settings-row"><div><strong>${esc(x.name)} ${x.id === p.defaultId ? '<span class="badge green">DEFAULT</span>' : ""}</strong><small>${esc(x.type)} · ${esc(x.model)} · API key ${x.masked_key ? esc(x.masked_key) : "missing"} · ${x.timeout_ms} ms timeout · ${x.input_tokens + x.output_tokens} tokens used${x.last_tested_at ? ` · tested ${esc(x.last_tested_at)} · ${x.last_latency_ms} ms` : ""}${x.last_error ? ` · ${esc(x.last_error)}` : ""}</small></div><span><button class="table-action" data-action="provider-edit" data-id="${esc(x.id)}">Edit</button><button class="table-action" data-action="provider-test" data-id="${esc(x.id)}">Test</button><button class="table-action" data-action="provider-default" data-id="${esc(x.id)}">Set default</button><button class="table-action" data-action="provider-delete" data-id="${esc(x.id)}">Remove</button></span></div>`).join("") : '<p class="panel-note">No saved provider profiles. The environment-selected provider is currently used.</p>'}</div><div class="panel" style="margin-top:12px"><div class="settings-row"><div><strong>Router backend</strong><small>Local lexical retrieval over active catalog</small></div><span class="badge green">bm25</span></div><div class="settings-row"><div><strong>Autonomy mode</strong><small>Proposals require human review</small></div><select class="select" id="autonomy"><option>suggest</option><option>manual</option><option>off</option></select></div>${[
      ["read", "allow"],
      ["write", "ask"],
      ["exec", "ask"],
      ["screen", "ask"],
      ["network", "ask"],
    ]
      .map(
        ([k, v]) =>
          `<div class="settings-row"><div><strong>${k} permission</strong><small>Default policy tier</small></div><span class="badge ${v === "allow" ? "green" : "amber"}">${v}</span></div>`,
      )
      .join(
        "",
      )}<div class="settings-row"><div><strong>Retention</strong><small>Run retention window</small></div><span>30 days</span></div><div class="settings-row"><div><strong>Stored preferences</strong><small>${s.items.length} local settings</small></div><span class="badge green">DIRECT LOCAL ACCESS</span></div></div>`;
}
async function handleAction(e) {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  const { action, id, status } = b.dataset;
  try {
    if (action === "inspect-run") return inspectRun(id);
    if (action === "approval-detail") {
      const row = cached.approvals.find((x) => x.id === id);
      return modal(
        "Exact action details",
        `<p class="panel-note">${esc(row?.tool)} · ${esc(row?.reason)}</p><div class="approval-content">${esc(JSON.stringify(JSON.parse(row?.args_json || "{}"), null, 2))}</div>`,
      );
    }
    if (action === "approval" || action === "proposal") {
      const payload = { status };
      if (action === "approval") { payload.args_hash = b.dataset.hash; payload.scope = b.dataset.scope || "once"; }
      await api(`/${action === "approval" ? "approvals" : "proposals"}/${id}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast(`${action === "approval" ? "Approval" : "Proposal"} ${status}`);
      return render();
    }
    if (action === "new-run") return showRunDialog();
    if (action === "save-workflow") return showWorkflowDialog();
    if (action === "workflow-edit") return showWorkflowDialog((cached.canvas?.workflows||[]).find(w=>w.id===id));
    if (action === "delete-workflow") { await api(`/workflows/${id}`, {method:"DELETE"}); toast("Workflow deleted"); return render(); }
    if (action === "run-workflow") { const r=await api(`/workflows/${id}/run`,{method:"POST",body:"{}"}); toast(`Workflow queued · ${r.id}`); return render(); }
    if (action === "create-task") return showTaskDialog();
    if (action === "create-agent" || action === "create-skill")
      return toast(
        "Library additions are proposed through the lifecycle workflow.",
      );
    if (action === "request-approval") return showApprovalDialog();
    if (action === "add-memory") return showMemoryDialog();
    if (action === "connector-info") return showConnectorDialog();
    if (action === "create-provider") return showProviderDialog();
    if (action === "mcp-add") { const name=prompt('MCP server name'); if(!name)return; const command=prompt('Executable command (absolute path recommended)'); if(!command)return; const args=prompt('Arguments as JSON array','[]'); if(args===null)return; const id=name.toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-|-$/g,''); await api('/mcp/servers',{method:'POST',body:JSON.stringify({id,name,command,args:JSON.parse(args)})}); toast('MCP server saved as untrusted'); return render(); }
    if (action === "mcp-trust") { const agents=(cached.agents||[]).filter(a=>a.status==='active').map(a=>a.id); const allowed=prompt(`Trust this executable and select allowed agent IDs (comma separated):\n${agents.join(', ')}`,agents[0]||''); if(allowed===null)return; const server=(await api('/mcp/servers/'+id)).item; await api('/mcp/servers/'+id,{method:'PUT',body:JSON.stringify({trusted:true,enabled:true,allowed_agents:allowed.split(',').map(x=>x.trim()).filter(Boolean)})}); toast('MCP server trusted and connection attempted'); return render(); }
    if (action === "mcp-disconnect") { await api('/mcp/servers/'+id+'/disconnect',{method:'POST',body:'{}'}); return render(); }
    if (action === "mcp-delete") { if(!confirm('Remove this MCP server configuration?'))return; await api('/mcp/servers/'+id,{method:'DELETE'}); return render(); }
    if (action === "provider-edit") return showProviderDialog((await api("/providers")).items.find((provider) => provider.id === id));
    if (action === "blackboard-acl") return showBlackboardAclDialog(b.dataset.run, b.dataset.key);
    if (action === "provider-default") {
      await api(`/providers/${id}/default`, { method: "POST", body: "{}" });
      toast("Default provider updated");
      return settings();
    }
    if (action === "provider-test") {
      const r = await api(`/providers/${id}/test`, {
        method: "POST",
        body: "{}",
      });
      toast(r.connected ? `Connected · ${r.latency_ms} ms` : r.error);
      return;
    }
    if (action === "provider-delete") {
      await api(`/providers/${id}`, { method: "DELETE" });
      toast("Provider removed");
      return settings();
    }
    if (action === "agent-info")
      return infoDialog(
        "Agent",
        cached.agents.find((x) => x.id === id),
      );
    if (action === "skill-info")
      return infoDialog(
        "Skill",
        cached.skills.find((x) => x.id === id),
      );
    if (action === "export") {
      const d = await api("/export");
      download(JSON.stringify(d, null, 2), "orchestra-export.json");
      return;
    }
  } catch (err) {
    toast(err.message);
  }
}
function infoDialog(kind, obj) {
  const text = kind === "Skill" ? obj?.body : obj?.description;
  modal(
    `${kind} details`,
    `${obj ? `<p class="panel-note">${esc(obj.id)} · ${esc(obj.status)}</p><div class="approval-content">${esc(text || "")}</div>` : "Record not found"}`,
  );
}
async function inspectRun(id) {
  const r = await api("/runs/" + id);
  if (activeStream) activeStream.close();
  modal(
    "Run inspector",
    `<div><div class="panel" style="margin-bottom:12px"><div class="panel-head"><span class="panel-title">Agent graph</span><span class="panel-note">Supervisor → dependency stages · up to three workers at once</span></div><div id="agent-graph" class="quick-grid"></div></div><div class="inspector"><div><div class="timeline-step"><div class="step-title">Router decision · ${esc(r.agent)}</div><div class="step-body">${esc(JSON.stringify(r.router, null, 2))}</div></div><div class="timeline-step"><div class="step-title">Live run events</div><div id="run-events"></div></div><div class="timeline-step"><div class="step-title">Recorded context</div>${(r.context||[]).map((c) => `<div class="context-segment"><b>${esc(c.kind)} · ${c.tokens || 0} tokens</b>\n${esc(JSON.stringify(c))}</div>`).join("")}</div></div><div><div class="panel" style="margin-bottom:12px"><div class="panel-title">Shared blackboard</div><div id="run-blackboard" class="panel-note"></div></div><div class="panel"><div class="panel-title">Run result</div><div class="approval-content" id="run-result">${esc(r.final_text || "The run is still in progress.")}</div><div class="health-row"><span class="health-key">Status</span><span id="run-status">${pill(r.status)}</span></div><div class="health-row"><span class="health-key">Durable checkpoint</span><span id="run-checkpoint">Checking…</span></div><div class="health-row"><span class="health-key">Tokens</span>${r.token_count || 0}</div><div class="health-row"><span class="health-key">Started</span>${fmtDate(r.created_at)}</div></div></div></div></div>`,
  );
  const refreshGraph=async()=>{const [d,current,board,checkpoint]=await Promise.all([api(`/runs/${id}/subtasks`),api(`/runs/${id}`),api(`/runs/${id}/blackboard`),api(`/runs/${id}/checkpoint`)]);const nodes=[{title:`Supervisor · ${current.agent}`,owner:current.agent,status:current.status,depends:[]},...d.items.map(s=>({title:s.title,owner:s.owner_agent,status:s.status,depends:JSON.parse(s.depends_on||'[]')}))];const box=$('#agent-graph');if(box)box.innerHTML=nodes.map((n,i)=>`<div class="quick-card"><strong>${i?'↳ ':''}${esc(n.owner)} · ${esc(n.status)}</strong><span>${esc(n.title)}${n.depends.length?` · after ${esc(n.depends.join(', '))}`:''}</span></div>`).join('');const result=$('#run-result');if(result)result.textContent=current.final_text||'The run is still in progress.';const status=$('#run-status');if(status)status.innerHTML=pill(current.status);const checkpointLabel=$('#run-checkpoint');if(checkpointLabel)checkpointLabel.innerHTML=checkpoint.checkpoint_retained?'<span class="badge amber">PERSISTED · awaiting recovery</span>':'<span class="badge green">NO ACTIVE CHECKPOINT</span>';const output=$('#run-blackboard');if(output)output.innerHTML=board.items.length?board.items.map(x=>`<div class="health-row"><b>${esc(x.key)}</b><span>${esc(JSON.stringify(JSON.parse(x.value)))}</span><small>${esc(x.author_agent)} · v${x.version}</small><button class="table-action" data-action="blackboard-acl" data-run="${esc(id)}" data-key="${esc(x.key)}">Access</button></div>`).join('')+`<details><summary>Provenance history (${board.history.length})</summary>${board.history.map(h=>`<div class="context-segment"><b>${esc(h.key)} · v${h.version} · ${esc(h.source)}</b><small>${esc(h.author_agent)} · ${esc(h.created_at)}</small><pre>${esc(h.value)}</pre></div>`).join('')}</details>`:'No shared entries yet.'};
  await refreshGraph();
  activeStream = new EventSource(`/api/runs/${id}/stream`);
  activeStream.onmessage = (e) => {};
  [
    "run.queued",
    "run.created",
    "plan.created",
    "subtask.created",
    "agent.started",
    "agent.tool_call",
    "agent.tool_result",
    "worker.event",
    "agent.message",
    "blackboard.updated",
    "budget.updated",
    "agent.blocked",
    "approval.requested",
    "agent.completed",
    "run.cancelled",
    "run.completed",
    "run.failed",
  ].forEach((type) =>
    activeStream.addEventListener(type, (e) => {
      const x = JSON.parse(e.data),
        el = document.createElement("div");
      el.className = "health-row";
      el.textContent = `${x.event} · ${JSON.stringify(x.payload)}`;
      $("#run-events")?.prepend(el);
      if(["subtask.created","agent.started","agent.completed","worker.event","agent.message","blackboard.updated"].includes(type))refreshGraph();
      if (["run.completed", "run.failed","run.cancelled"].includes(type)) {
        activeStream.close();
        render();
      }
    }),
  );
  $("#dialog").addEventListener(
    "close",
    () => {
      activeStream?.close();
      activeStream = null;
    },
    { once: true },
  );
}
function modal(title, body, foot = "") {
  const d = $("#dialog");
  d.innerHTML = `<div class="dialog-head"><strong>${esc(title)}</strong><button class="icon-button" data-close>×</button></div><div class="dialog-body">${body}${foot}</div>`;
  d.showModal();
  d.querySelector("[data-close]").onclick = () => d.close();
}
async function showRunDialog() {
  const d = cached.canvas || await api("/canvas");
  const opts = list => list.map(x=>`<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.model||x.category||"")}</option>`).join("");
  modal(
    "Start a run",
    `<form id="run-form"><label>What should Orchestra do?</label><textarea name="task" required maxlength="10000" placeholder="Describe the task"></textarea><label>Agent assignment</label><select name="agent_id" class="select"><option value="">Automatic task planning</option>${opts(d.agents)}</select><label>Provider / model override</label><select name="provider_id" class="select"><option value="">Use agent routing</option>${opts(d.providers.filter(x=>x.enabled))}</select><div class="dialog-foot"><button type="button" class="button" data-close>Cancel</button><button class="button primary">Start local run</button></div></form>`,
  );
  $("#run-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api("/runs", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
      });
      $("#dialog").close();
      toast(`Run queued · ${r.decision.agent}`);
      go("runs");
    } catch (err) {
      toast(err.message);
    }
  };
}
async function showWorkflowDialog(workflow=null){
  const d=cached.canvas||await api("/canvas"), prior=workflow?.definition.items||[{key:"step-1",title:"Research the topic",owner:d.agents[0]?.id||"general",depends:[],providerId:null}], agentOptions=d.agents.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.category)}</option>`).join(""), providerOptions=d.providers.filter(p=>p.enabled).map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.model)}</option>`).join("");
  const row=item=>`<div class="workflow-step"><div class="workflow-step-head"><b>${esc(item.key)}</b><button type="button" class="table-action" data-remove-step>Remove step</button></div><label>Step key</label><input data-key required maxlength="40" value="${esc(item.key)}"><label>Outcome</label><input data-title required maxlength="250" value="${esc(item.title)}"><label>Agent</label><select data-owner class="select">${agentOptions}</select><label>Depends on keys (comma separated)</label><input data-depends value="${esc((item.depends||[]).join(", "))}" placeholder="step-1"><label>Provider override</label><select data-provider class="select"><option value="">Use agent routing</option>${providerOptions}</select><input type="hidden" data-initial-owner value="${esc(item.owner)}"><input type="hidden" data-initial-provider value="${esc(item.providerId||"")}"></div>`;
  const heading=workflow?"Edit workflow":"Save workflow";
  modal(heading,`<form id="workflow-form"><label>Name</label><input name="name" required maxlength="100" value="${esc(workflow?.name||"")}" placeholder="Research and review"><label>Description</label><input name="description" maxlength="1000" value="${esc(workflow?.description||"")}"><div class="workflow-steps-head"><strong>Workflow steps</strong><button type="button" class="button tiny" id="add-workflow-step">Add step</button></div><div id="workflow-steps">${prior.map(row).join("")}</div><div class="dialog-foot"><button type="button" class="button" data-close>Cancel</button><button class="button primary">${workflow?"Save changes":"Save workflow"}</button></div></form>`);
  const steps=$("#workflow-steps");
  const bindRows=()=>{steps.querySelectorAll(".workflow-step").forEach(box=>{const owner=box.querySelector("[data-owner]"),provider=box.querySelector("[data-provider]");owner.value=box.querySelector("[data-initial-owner]").value;provider.value=box.querySelector("[data-initial-provider]").value;box.querySelector("[data-remove-step]").onclick=()=>{if(steps.children.length>1)box.remove();else toast("A workflow needs at least one step");};});};
  bindRows();
  $("#add-workflow-step").onclick=()=>{const n=steps.children.length+1;steps.insertAdjacentHTML("beforeend",row({key:`step-${n}`,title:"New outcome",owner:d.agents[0]?.id||"general",depends:[],providerId:null}));bindRows();};
  $("#workflow-form").onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));const nodes=[...steps.querySelectorAll(".workflow-step")].map(box=>({key:box.querySelector("[data-key]").value.trim(),title:box.querySelector("[data-title]").value.trim(),owner:box.querySelector("[data-owner]").value,providerId:box.querySelector("[data-provider]").value||null,depends:box.querySelector("[data-depends]").value.split(",").map(x=>x.trim()).filter(Boolean)}));try{await api(workflow?`/workflows/${workflow.id}`:"/workflows",{method:workflow?"PUT":"POST",body:JSON.stringify({name:f.name,description:f.description,definition:{nodes}})});$("#dialog").close();toast(workflow?"Workflow updated":"Workflow saved locally");render();}catch(err){toast(err.message)}};
}
function showTaskDialog() {
  modal(
    "Create task",
    `<form id="task-form"><label>Task title</label><input name="title" required maxlength="250"><label>Owner agent</label><select name="owner" class="select"><option>general</option><option>coder</option><option>reviewer</option><option>planner</option></select><div class="dialog-foot"><button type="button" class="button" data-close>Cancel</button><button class="button primary">Add task</button></div></form>`,
  );
  $("#task-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api("/tasks", {
      method: "POST",
      body: JSON.stringify({ title: f.get("title"), owner: f.get("owner") }),
    }).catch(async () => {
      toast("Task creation endpoint unavailable");
    });
    $("#dialog").close();
    render();
  };
}
function showApprovalDialog() {
  modal(
    "Request approval",
    `<form id="approval-form"><label>Tool</label><input name="tool" placeholder="example: gmail.send" required><label>Permission tier</label><select name="tier" class="select"><option>network</option><option>write</option><option>exec</option><option>screen</option></select><label>Exact arguments for review</label><textarea name="args" required placeholder='{"to":"...","subject":"...","body":"..."}'></textarea><label><input type="checkbox" name="tainted"> Untrusted content was present in the context</label><div class="dialog-foot"><button type="button" class="button" data-close>Cancel</button><button class="button primary">Request review</button></div></form>`,
  );
  $("#approval-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("/approvals", {
        method: "POST",
        body: JSON.stringify({
          tool: f.get("tool"),
          tier: f.get("tier"),
          args: JSON.parse(f.get("args")),
          tainted: f.has("tainted"),
        }),
      });
      $("#dialog").close();
      toast("Approval request created");
      go("approvals");
    } catch (err) {
      toast(err.message);
    }
  };
}
function showMemoryDialog() {
  modal(
    "Add memory",
    `<form id="memory-form"><label>Scope</label><select name="scope" class="select"><option>workspace</option><option>private</option></select><label>Memory</label><textarea name="text" required maxlength="20000" placeholder="A durable fact for future local work"></textarea><div class="dialog-foot"><button type="button" class="button" data-close>Cancel</button><button class="button primary">Save memory</button></div></form>`,
  );
  $("#memory-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("/memories", {
        method: "POST",
        body: JSON.stringify({ scope: f.get("scope"), text: f.get("text") }),
      });
      $("#dialog").close();
      toast("Memory saved locally");
      render();
    } catch (err) {
      toast(err.message);
    }
  };
}
function showConnectorDialog() {
  modal(
    "Connector setup",
    `<p class="panel-note">Connectors are not active in this build. No OAuth client, credentials, or Gmail API integration is configured.</p><div class="settings-row"><div><strong>Least privilege</strong><small>Start with read-only scopes; request write or send scopes separately.</small></div></div><div class="settings-row"><div><strong>Approval policy</strong><small>Email send, archive, and label actions require exact-content review.</small></div></div><p class="panel-note">See docs/CONNECTORS.md for setup status and the manual account checklist.</p>`,
  );
}
function download(text, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
init();

function showProviderDialog(profile = null) {
  const editing = Boolean(profile), value = (key, fallback = "") => esc(profile?.[key] ?? fallback);
  modal(
    editing ? "Edit provider profile" : "Add provider profile",
    `<form id="provider-form"><label>Profile name</label><input name="name" required maxlength="80" value="${value("name")}" placeholder="Work Claude"><label>Provider</label><select name="type" class="select"><option value="anthropic" ${profile?.type === "anthropic" ? "selected" : ""}>Anthropic / Claude</option><option value="openai-compatible" ${profile?.type === "openai-compatible" ? "selected" : ""}>OpenAI-compatible / Ollama</option></select><label>Base URL (OpenAI-compatible)</label><input name="base_url" value="${value("base_url")}" placeholder="http://localhost:11434/v1"><label>Model</label><input name="model" required value="${value("model")}" placeholder="model name"><label>API key (optional; leave blank to keep current)</label><input name="api_key" type="password" autocomplete="new-password"><label>Request timeout (ms)</label><input name="timeout_ms" type="number" min="250" max="120000" value="${value("timeout_ms", 30000)}" required><label>Maximum response tokens</label><input name="max_tokens" type="number" min="1" max="8192" value="${value("max_tokens", 1200)}" required><label>Temperature</label><input name="temperature" type="number" min="0" max="2" step="0.1" value="${value("temperature", 0.2)}" required><label>Enabled</label><select name="enabled" class="select"><option value="true" ${!profile || profile.enabled ? "selected" : ""}>Enabled</option><option value="false" ${profile && !profile.enabled ? "selected" : ""}>Disabled</option></select><p class="panel-note">The key is stored in the operating system credential vault, not in SQLite, and is never returned by the daemon.</p><div class="dialog-foot"><button type="button" class="button" data-close>Cancel</button><button class="button primary">${editing ? "Save changes" : "Save provider"}</button></div></form>`,
  );
  $("#provider-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target), payload = Object.fromEntries(f);
    payload.enabled = payload.enabled === "true";
    try {
      await api(editing ? `/providers/${encodeURIComponent(profile.id)}` : "/providers", { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) });
      $("#dialog").close();
      toast(editing ? "Provider profile updated" : "Provider profile saved");
      settings();
    } catch (err) { toast(err.message); }
  };
}


async function showBlackboardAclDialog(runId, key) {
  const agents = await api("/agents");
  modal("Blackboard key access", `<form id="blackboard-acl-form"><p class="panel-note">${esc(key)}</p><label>Agent</label><select name="agent_id" class="select" required>${agents.items.filter((a) => a.status === "active").map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")}</select><label><input type="checkbox" name="can_read"> Allow read</label><label><input type="checkbox" name="can_write"> Allow write</label><div class="dialog-foot"><button type="button" class="button" data-close>Cancel</button><button class="button primary">Save access</button></div></form>`);
  $("#blackboard-acl-form").onsubmit = async (event) => { event.preventDefault(); const form = new FormData(event.target); try { await api(`/runs/${encodeURIComponent(runId)}/blackboard`, { method: "POST", body: JSON.stringify({ key, access: { agent_id: form.get("agent_id"), can_read: form.has("can_read"), can_write: form.has("can_write") } }) }); $("#dialog").close(); toast("Blackboard access updated"); await inspectRun(runId); } catch (error) { toast(error.message); } };
}
