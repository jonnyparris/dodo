// dodo-files.js — File tree, git, prompts, cron, memory, config, allowlist

// --- Files (recursive expansion) ---
let _loadFilesTimer=null;
function loadFilesDebounced(){if(_loadFilesTimer)return;_loadFilesTimer=setTimeout(()=>{_loadFilesTimer=null;loadFiles("/")},200)}
async function loadFiles(path){
  if(!currentSession)return;
  if(path==="/"&&!$("file-tree").innerHTML)showSkeleton($("file-tree"),3);
  try{
    const{entries}=await api(`/session/${currentSession}/files?path=${encodeURIComponent(path)}`);
    if(path==="/"){$("file-tree").innerHTML=entries.length?renderFileEntries(entries,path):'<div class="empty">Empty workspace</div>'}
    else{const container=document.getElementById(`dir-${path}`);if(container)container.innerHTML=renderFileEntries(entries,path)}
  }catch{if(path==="/")$("file-tree").innerHTML='<div class="empty">Empty workspace</div>'}
}
function renderFileEntries(entries,parentPath){
  return entries.map(e=>{
    if(e.type==="directory"){
      const expanded=expandedDirs.has(e.path);
      return `<div class="file-entry" onclick="toggleDir('${esc(e.path)}')"><span><i class="ph ph-caret-${expanded?'down':'right'}"></i></span><span><i class="ph ph-folder${expanded?'-open':''}"></i> ${esc(e.name)}</span></div>${expanded?`<div class="file-children" id="dir-${esc(e.path)}"></div>`:''}`
    }
    return `<div class="file-entry" onclick="readFile('${esc(e.path)}')"><span><i class="ph ph-file"></i></span><span>${esc(e.name)}</span></div>`
  }).join("")
}
async function toggleDir(path){
  if(expandedDirs.has(path)){expandedDirs.delete(path);loadFiles("/")}
  else{expandedDirs.add(path);await loadFiles("/");await loadFiles(path)}
}
async function readFile(path){
  if(!currentSession)return;
  const d=await apiSafe(`/session/${currentSession}/file?path=${encodeURIComponent(path)}`);
  if(!d)return;
  const{content}=d;
  const overlay=document.createElement('div');
  overlay.className='help-overlay';
  overlay.onclick=(e)=>{if(e.target===overlay)overlay.remove()};
  const ext=path.split('.').pop()||'';
  const lang=['js','ts','jsx','tsx','json','html','css','py','rs','go','sh','yaml','yml','toml','md'].includes(ext)?ext:'';
  const rendered=typeof marked!=="undefined"&&ext==='md'?marked.parse(content||''):null;
  overlay.innerHTML=`<div class="help-content" style="max-width:720px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3 style="font-family:var(--mono);font-size:13px;word-break:break-all">${esc(path)}</h3>
      <div style="display:flex;gap:6px">
        <button onclick="navigator.clipboard.writeText(this.closest('.help-content').querySelector('pre,article')?.textContent||'').then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)})" class="sm">Copy</button>
        <button onclick="this.closest('.help-overlay').remove()" class="sm">Close</button>
      </div>
    </div>
    ${rendered?`<article style="line-height:1.6">${rendered}</article>`:`<pre style="background:var(--code-bg);color:var(--code-text);padding:14px;border-radius:8px;overflow:auto;max-height:60vh;font-size:12px;line-height:1.45"><code class="language-${lang}">${esc(content||'(empty)')}</code></pre>`}
  </div>`;
  document.body.appendChild(overlay);
}

// --- Config ---
async function loadConfig(){const cfg=await apiSafe("/api/config");if(!cfg)return;$("cfg-model").value=cfg.model;$("cfg-gateway").value=cfg.activeGateway;const gwUrl=cfg.activeGateway==="opencode"?cfg.opencodeBaseURL:cfg.aiGatewayBaseURL;$("cfg-gateway-url").value=gwUrl||"";$("cfg-git-author-name").value=cfg.gitAuthorName||"";$("cfg-git-author-email").value=cfg.gitAuthorEmail||"";$("config-display").innerHTML=`<div class="kv"><span>Model</span><code>${esc(cfg.model)}</code></div><div class="kv"><span>Gateway</span><code>${esc(cfg.activeGateway)}</code></div><div class="kv"><span>Git Author</span><code>${esc(cfg.gitAuthorName)} &lt;${esc(cfg.gitAuthorEmail)}&gt;</code></div>`}
async function saveConfig(){const gw=$("cfg-gateway").value;const body={model:$("cfg-model").value,activeGateway:gw,gitAuthorName:$("cfg-git-author-name").value.trim(),gitAuthorEmail:$("cfg-git-author-email").value.trim()};const url=$("cfg-gateway-url").value.trim();if(url){if(gw==="opencode")body.opencodeBaseURL=url;else body.aiGatewayBaseURL=url}const r=await jsonSafe("/api/config",body,"PUT");if(r)toast('Config saved','success');else toast('Failed to save config','error');await loadConfig()}

// --- Allowlist ---
async function loadAllowlist(){const d=await apiSafe("/api/allowlist");if(!d)return;const{hosts}=d;$("allowlist-display").innerHTML=hosts.length?hosts.map(h=>`<div class="kv"><code>${esc(h.hostname)}</code><button onclick="removeHost('${esc(h.hostname)}')" class="sm">x</button></div>`).join(""):'<div class="empty">No hosts</div>'}
async function addHost(){const hostname=$("allowlist-input").value.trim();if(!hostname)return;const r=await jsonSafe("/api/allowlist",{hostname});if(r)toast('Host added','success');$("allowlist-input").value="";await loadAllowlist()}
async function removeHost(hostname){await apiSafe(`/api/allowlist/${encodeURIComponent(hostname)}`,{method:"DELETE"});await loadAllowlist()}

// --- Prompts (kept for backward compat — UI section removed) ---
function loadPrompts(){}

// --- Session todos ---
// Rendered in the right panel (`#session-todos-list`). Hydrated by the SSE
// `todos` event, which the server fires on connect and after every mutation
// from the agent's todo_* tools. No polling.
const TODO_STATUS_ICONS={
  pending:'<i class="ph ph-circle"></i>',
  in_progress:'<i class="ph ph-spinner-gap"></i>',
  completed:'<i class="ph ph-check-circle-fill"></i>',
  cancelled:'<i class="ph ph-x-circle"></i>',
};
function renderSessionTodos(items){
  const list=$("session-todos-list");
  const empty=$("session-todos-empty");
  if(!list)return;
  const arr=Array.isArray(items)?items:[];
  if(!arr.length){
    list.innerHTML="";
    if(empty)empty.style.display="";
    return;
  }
  if(empty)empty.style.display="none";
  // Order: in_progress first, then pending, then completed, then cancelled.
  const rank={in_progress:0,pending:1,completed:2,cancelled:3};
  const sorted=[...arr].sort((a,b)=>(rank[a.status]??9)-(rank[b.status]??9)||a.id-b.id);
  list.innerHTML=sorted.map(t=>{
    const icon=TODO_STATUS_ICONS[t.status]||TODO_STATUS_ICONS.pending;
    return `<div class="session-todo" data-id="${t.id}" data-status="${esc(t.status)}" data-priority="${esc(t.priority||"medium")}"><span class="todo-icon">${icon}</span><span class="todo-text">${esc(t.content)}</span><span class="todo-priority">${esc(t.priority||"")}</span></div>`;
  }).join("");
}
async function loadSessionTodos(){
  if(!currentSession){renderSessionTodos([]);return}
  try{const{items}=await api(`/session/${currentSession}/todos`);renderSessionTodos(items||[])}
  catch{renderSessionTodos([])}
}

// --- Cron ---
async function loadCron(){if(!currentSession)return;try{const{jobs}=await api(`/session/${currentSession}/cron`);$("cron-list").innerHTML=jobs.length?jobs.map(j=>`<div class="kv"><span>${esc(j.description)}</span><button onclick="deleteCron('${esc(j.id)}')" class="sm">x</button></div>`).join(""):'<div class="empty">No cron jobs</div>'}catch{$("cron-list").innerHTML='<div class="empty">No cron jobs</div>'}}
async function createCron(){if(!currentSession)return;const desc=$("cron-desc").value.trim();const prompt=$("cron-prompt").value.trim();const delay=parseInt($("cron-delay").value,10);if(!desc||!prompt||!delay)return;const r=await jsonSafe(`/session/${currentSession}/cron`,{description:desc,prompt,type:"delayed",delayInSeconds:delay});if(r)toast('Cron job scheduled','success');$("cron-desc").value="";$("cron-prompt").value="";$("cron-delay").value="";await loadCron()}
async function deleteCron(id){if(!currentSession)return;await apiSafe(`/session/${currentSession}/cron/${encodeURIComponent(id)}`,{method:"DELETE"});await loadCron()}

// --- Memory ---
async function loadMemory(query){const q=query??$("mem-search")?.value??"";const d=await apiSafe(`/api/memory${q?`?q=${encodeURIComponent(q)}`:""}`);if(!d)return;const{entries}=d;$("memory-list").innerHTML=entries.length?entries.slice(0,15).map(e=>`<div class="kv" style="flex-wrap:wrap"><span style="cursor:pointer" onclick="editMemory('${esc(e.id)}')">${esc(e.title)}</span><span style="display:flex;gap:4px;align-items:center">${(e.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join("")}<button onclick="deleteMemory('${esc(e.id)}')" class="sm">x</button></span></div>`).join(""):'<div class="empty">No entries</div>'}
async function editMemory(id){const entry=await apiSafe(`/api/memory/${encodeURIComponent(id)}`);if(!entry)return;$("mem-id").value=entry.id;$("mem-title").value=entry.title;$("mem-content").value=entry.content;$("mem-tags").value=(entry.tags||[]).join(", ");const details=$("mem-title").closest("details");if(details)details.open=true}
function clearMemoryForm(){$("mem-id").value="";$("mem-title").value="";$("mem-content").value="";$("mem-tags").value=""}
async function saveMemory(){const id=$("mem-id").value;const title=$("mem-title").value.trim();const content=$("mem-content").value.trim();const tags=$("mem-tags").value.split(",").map(t=>t.trim()).filter(Boolean);if(!title||!content)return;let r;if(id){r=await jsonSafe(`/api/memory/${encodeURIComponent(id)}`,{title,content,tags},"PUT")}else{r=await jsonSafe("/api/memory",{title,content,tags})}if(r)toast('Memory saved','success');else toast('Failed to save','error');clearMemoryForm();await loadMemory()}
async function deleteMemory(id){await apiSafe(`/api/memory/${encodeURIComponent(id)}`,{method:"DELETE"});await loadMemory()}

// --- Git ---
// Render the "Clone this session's repo" affordance in the Git panel.
// Fetches /session/{id}/artifacts (which returns a short-lived
// authenticated clone URL). Cached for the life of the panel render so
// we don't mint a fresh token on every refreshGit() tick.
async function refreshArtifactsClone(){
  const el=$("artifacts-clone");if(!el||!currentSession)return;
  const d=await apiSafe(`/session/${currentSession}/artifacts`);
  if(!d||!d.cloneUrl){el.innerHTML="";return}
  // Mask the token in the visible URL but keep the full one for copy.
  const masked=d.cloneUrl.replace(/:([^@/]+)@/,":***@");
  el.innerHTML=`<details><summary style="font-size:12px;font-weight:600;cursor:pointer">Clone this session</summary>
    <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
      <code style="flex:1;font-size:11px;background:var(--code-bg);color:var(--code-text);padding:6px 8px;border-radius:4px;overflow:auto;white-space:nowrap">${esc(masked)}</code>
      <button class="sm" onclick="copyCloneUrl(this,'${esc(d.cloneUrl)}')">Copy</button>
    </div>
    <p style="font-size:10px;color:var(--muted);margin-top:4px">Token expires in ${Math.round((d.tokenTtlSeconds||3600)/60)} min. Refresh this panel to mint a new one.</p>
  </details>`;
}
function copyCloneUrl(btn,url){
  navigator.clipboard.writeText(url).then(()=>{const t=btn.textContent;btn.textContent='Copied!';setTimeout(()=>{btn.textContent=t},1500)})
}
async function refreshGit(){
  if(!currentSession){$("git-status-display").innerHTML="";$("git-log-display").innerHTML="";const ac=$("artifacts-clone");if(ac)ac.innerHTML="";return}
  // Fire-and-forget — clone URL render is independent of git status.
  refreshArtifactsClone().catch(()=>{});
  try{
    const{entries}=await api(`/session/${currentSession}/git/status`);
    // Filter out false "untracked" files: after clone, isomorphic-git's statusMatrix
    // may report all files as "new, untracked" (HEAD=0, workdir=2, stage=0) due to
    // a workspace filesystem adapter issue. If ALL entries are "new, untracked",
    // it's almost certainly a false positive — show as clean instead.
    const meaningful=entries.filter(e=>e.status!=="new, untracked");
    const allUntracked=entries.length>0&&meaningful.length===0;
    const display=allUntracked?[]:entries;
    const el=$("git-status-display");
    // Make scrollable when the file list is long
    el.style.maxHeight=display.length>10?"200px":"";
    el.style.overflowY=display.length>10?"auto":"";
    el.innerHTML=display.length?display.map(e=>`<div style="font-size:11px;font-family:var(--mono)">${esc(e.status)} ${esc(e.filepath)}</div>`).join(""):'<div class="empty">Clean or no repo</div>'
  }catch{$("git-status-display").innerHTML='<div class="empty">No repo</div>'}
  // Load recent commits
  try{
    const{entries}=await api(`/session/${currentSession}/git/log?depth=10`);
    const el=$("git-log-display");if(!el)return;
    // Resolve the remote URL to build commit links (fire-and-forget, cached)
    if(!_gitRemoteUrlCache&&entries&&entries.length){
      jsonSafe(`/session/${currentSession}/git/remote`,{list:true}).then(r=>{
        if(Array.isArray(r)){const origin=r.find(x=>x.remote==='origin');if(origin)_gitRemoteUrlCache=origin.url;refreshGitLog(entries)}
      }).catch(()=>{})
    }
    refreshGitLog(entries);
  }catch{/* no repo or no commits — git-log-display stays empty */}
}
let _gitRemoteUrlCache='';
function refreshGitLog(entries){
  const el=$("git-log-display");if(!el)return;
  const commitBaseUrl=_gitCommitUrl(_gitRemoteUrlCache);
  el.innerHTML=entries&&entries.length?`<details open><summary style="font-size:12px;font-weight:600;cursor:pointer;margin-bottom:4px">Recent commits</summary>${entries.map(e=>{const short=(e.oid||'').slice(0,7);const fullOid=e.oid||'';const msg=esc((e.message||'').split('\n')[0].slice(0,60));const date=e.author?.timestamp?new Date(e.author.timestamp*1000).toLocaleDateString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'';const commitUrl=commitBaseUrl?commitBaseUrl+fullOid:'';const oidHtml=commitUrl?`<a href="${esc(commitUrl)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;flex-shrink:0" title="Open commit">${short}</a>`:`<code style="color:var(--accent);flex-shrink:0">${short}</code>`;return`<div style="font-size:11px;font-family:var(--mono);padding:2px 0;display:flex;gap:6px;align-items:baseline">${oidHtml}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${msg}</span><span style="color:var(--muted);flex-shrink:0;font-size:10px">${date}</span></div>`}).join('')}</details>`:''
}
// Convert a git remote URL to a commit URL base (e.g. https://github.com/owner/repo/commit/)
function _gitCommitUrl(remoteUrl){
  if(!remoteUrl)return'';
  // HTTPS: https://github.com/owner/repo.git or https://github.com/owner/repo
  let m=remoteUrl.match(/https?:\/\/(github\.com|gitlab\.com|gitlab\.[^/]+)\/(.+?)(?:\.git)?$/);
  if(m)return`https://${m[1]}/${m[2]}/commit/`;
  // SSH: git@github.com:owner/repo.git
  m=remoteUrl.match(/git@(github\.com|gitlab\.com|gitlab\.[^:]+):(.+?)(?:\.git)?$/);
  if(m)return`https://${m[1]}/${m[2]}/commit/`;
  return'';
}
async function gitInit(){if(!currentSession)return;await jsonSafe(`/session/${currentSession}/git/init`,{});await refreshGit()}
async function gitAddAll(){if(!currentSession)return;await jsonSafe(`/session/${currentSession}/git/add`,{filepath:"."});await refreshGit()}
async function gitCommitPrompt(){if(!currentSession)return;const message=prompt("Commit message:");if(!message)return;await jsonSafe(`/session/${currentSession}/git/commit`,{message});await refreshGit()}
