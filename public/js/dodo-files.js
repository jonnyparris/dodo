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
    else{const container=$(`dir-${CSS.escape(path)}`);if(container)container.innerHTML=renderFileEntries(entries,path)}
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
async function loadConfig(){const cfg=await apiSafe("/api/config");if(!cfg)return;$("cfg-model").value=cfg.model;$("cfg-gateway").value=cfg.activeGateway;const gwUrl=cfg.activeGateway==="opencode"?cfg.opencodeBaseURL:cfg.aiGatewayBaseURL;$("cfg-gateway-url").value=gwUrl||"";$("config-display").innerHTML=`<div class="kv"><span>Model</span><code>${esc(cfg.model)}</code></div><div class="kv"><span>Gateway</span><code>${esc(cfg.activeGateway)}</code></div><div class="kv"><span>Git</span><code>${esc(cfg.gitAuthorName)}</code></div>`}
async function saveConfig(){const gw=$("cfg-gateway").value;const body={model:$("cfg-model").value,activeGateway:gw};const url=$("cfg-gateway-url").value.trim();if(url){if(gw==="opencode")body.opencodeBaseURL=url;else body.aiGatewayBaseURL=url}const r=await jsonSafe("/api/config",body,"PUT");if(r)toast('Config saved','success');else toast('Failed to save config','error');await loadConfig()}

// --- Allowlist ---
async function loadAllowlist(){const d=await apiSafe("/api/allowlist");if(!d)return;const{hosts}=d;$("allowlist-display").innerHTML=hosts.length?hosts.map(h=>`<div class="kv"><code>${esc(h.hostname)}</code><button onclick="removeHost('${esc(h.hostname)}')" class="sm">x</button></div>`).join(""):'<div class="empty">No hosts</div>'}
async function addHost(){const hostname=$("allowlist-input").value.trim();if(!hostname)return;const r=await jsonSafe("/api/allowlist",{hostname});if(r)toast('Host added','success');$("allowlist-input").value="";await loadAllowlist()}
async function removeHost(hostname){await apiSafe(`/api/allowlist/${encodeURIComponent(hostname)}`,{method:"DELETE"});await loadAllowlist()}

// --- Prompts (kept for backward compat — UI section removed) ---
function loadPrompts(){}

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
async function refreshGit(){
  if(!currentSession){$("git-status-display").innerHTML="";$("git-log-display").innerHTML="";return}
  try{const{entries}=await api(`/session/${currentSession}/git/status`);$("git-status-display").innerHTML=entries.length?entries.map(e=>`<div style="font-size:11px;font-family:var(--mono)">${esc(e.status)} ${esc(e.filepath)}</div>`).join(""):'<div class="empty">Clean or no repo</div>'}catch{$("git-status-display").innerHTML='<div class="empty">No repo</div>'}
  // Load recent commits
  try{const{entries}=await api(`/session/${currentSession}/git/log?depth=10`);const el=$("git-log-display");if(!el)return;el.innerHTML=entries&&entries.length?`<details open><summary style="font-size:12px;font-weight:600;cursor:pointer;margin-bottom:4px">Recent commits</summary>${entries.map(e=>{const short=(e.oid||'').slice(0,7);const msg=esc((e.commit?.message||'').split('\n')[0].slice(0,60));const author=esc(e.commit?.author?.name||'');const date=e.commit?.author?.timestamp?new Date(e.commit.author.timestamp*1000).toLocaleDateString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'';return`<div style="font-size:11px;font-family:var(--mono);padding:2px 0;display:flex;gap:6px;align-items:baseline"><code style="color:var(--accent);flex-shrink:0">${short}</code><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${msg}</span><span style="color:var(--muted);flex-shrink:0;font-size:10px">${date}</span></div>`}).join('')}</details>`:''
  }catch{/* no repo or no commits — git-log-display stays empty */}
}
async function gitInit(){if(!currentSession)return;await jsonSafe(`/session/${currentSession}/git/init`,{});await refreshGit()}
async function gitAddAll(){if(!currentSession)return;await jsonSafe(`/session/${currentSession}/git/add`,{filepath:"."});await refreshGit()}
async function gitCommitPrompt(){if(!currentSession)return;const message=prompt("Commit message:");if(!message)return;await jsonSafe(`/session/${currentSession}/git/commit`,{message});await refreshGit()}
