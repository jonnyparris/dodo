// dodo-settings.js — Identity, passkeys, secrets, integrations, session settings, permissions, sharing, browser, approvals, MCP overrides

function humanizeSecretName(name,configs){const m=name.match(/^mcp:([0-9a-f-]+):(.+)$/i);if(m&&configs){const c=configs.find(x=>x.id===m[1]);if(c)return "mcp:"+c.name+":"+m[2]}return name}

// --- Identity ---
async function loadIdentity(){
  try{
    const{email,isAdmin}=await api("/api/identity");
    window._userEmail=email;
    $("identity-display").innerHTML=`${esc(email)}${isAdmin?' <span class="tag">admin</span>':''}`;
  }catch{$("identity-display").textContent=""}
}

// --- Passkey & Secrets ---
async function loadPasskeyStatus(){
  try{
    const{initialized}=await api("/api/passkey/status");
    $("passkey-status").innerHTML=initialized?'<div style="font-size:11px;color:var(--accent)">Passkey configured</div>':'<div style="font-size:11px;color:var(--red)">No passkey set</div>';
    if(!initialized){$("passkey-init-form").style.display="block";$("secret-add-form").style.display="none"}
    else{$("passkey-init-form").style.display="none";$("secret-add-form").style.display="block"}
  }catch{$("passkey-status").innerHTML=""}
}
async function initPasskey(){
  const passkey=$("passkey-input").value;if(!passkey||passkey.length<4)return toast("Passkey must be at least 4 characters","warning");
  await jsonSafe("/api/passkey/init",{passkey});$("passkey-input").value="";await loadPasskeyStatus();await loadSecrets()
}
async function changePasskey(){
  const current=$("passkey-current").value,newPk=$("passkey-new").value;
  if(!current||!newPk||newPk.length<4)return toast("Both fields required, new passkey min 4 chars","warning");
  try{await json("/api/passkey/change",{currentPasskey:current,newPasskey:newPk});$("passkey-current").value="";$("passkey-new").value="";toast("Passkey changed","success")}catch(e){toast("Failed: "+(e.message||e),"error")}
}
async function loadSecrets(){
  try{
    const{keys}=await api("/api/secrets");
    $("secrets-list").innerHTML=keys.length?keys.map(k=>`<div class="kv"><code>${esc(humanizeSecretName(k,mcpConfigs))}</code><button onclick="deleteSecret('${esc(k)}')" class="sm">x</button></div>`).join(""):'<div class="empty">No secrets</div>';
  }catch{$("secrets-list").innerHTML='<div class="empty">No secrets</div>'}
}
async function setSecret(){
  const key=$("secret-key").value,value=$("secret-value").value;if(!key||!value)return;
  const r=await jsonSafe(`/api/secrets/${encodeURIComponent(key)}`,{value},"PUT");if(r)toast('Secret saved','success');else toast('Failed to save secret','error');$("secret-value").value="";await loadSecrets()
}
async function deleteSecret(key){await apiSafe(`/api/secrets/${encodeURIComponent(key)}`,{method:"DELETE"});await loadSecrets()}

// --- Status & models ---
let _bootCommit=null;

async function loadStatus(){
  try{
    const s=await api("/api/status");
    let commit=s.commit||'';
    if(!commit&&!(s.version||'').includes('-dev')){try{const r=await fetch("/version.json");if(r.ok){const v=await r.json();commit=v.commit||''}}catch{}}
    const commitStr=commit?` (${esc(commit.slice(0,7))})`:'';
    const versionLabel=`Dodo v${esc(s.version)}${commitStr}`;
    $("footer-text").innerHTML=`<img src="/favicon.svg" alt="" width="14" height="14" style="opacity:.7" class="dodo-logo-img"/> ${versionLabel}`;
    const bv=$("build-version");if(bv)bv.textContent=commit?`build ${esc(commit.slice(0,7))}`:`v${esc(s.version)}`;
    const sv=$("sidebar-version");if(sv)sv.textContent=versionLabel;
    if(!_bootCommit&&commit)_bootCommit=commit;
  }catch{}
}

// Called on SSE reconnect — a deploy restarts the DO, which drops and
// re-establishes the SSE connection.  One fetch on reconnect, zero polling.
async function checkVersionOnReconnect(){
  if(!_bootCommit)return;
  try{
    const s=await api("/api/status");
    if(s.commit&&s.commit!==_bootCommit)showUpdateBanner(s.commit);
  }catch{/* transient failure, next reconnect will try again */}
}

function showUpdateBanner(commit){
  const banner=$("banner-container");
  if(!banner||banner.querySelector('.update-banner'))return;
  const short=commit?commit.slice(0,7):'';
  const el=document.createElement('div');
  el.className='update-banner';
  el.innerHTML=`<span>New version deployed${short?` (${esc(short)})`:''} \u2014 </span><button onclick="location.reload()">Reload</button><button class="ghost sm" onclick="this.parentElement.remove()" style="margin-left:4px;padding:2px 6px;font-size:11px" aria-label="Dismiss">\u00d7</button>`;
  banner.appendChild(el);
  // Auto-reload background tabs that aren't mid-prompt
  if(document.hidden&&!isProcessing){
    setTimeout(()=>{if(document.hidden&&!isProcessing)location.reload()},3000);
  }
  // Auto-reload when user returns to a stale tab
  document.addEventListener('visibilitychange',function _autoReload(){
    if(!document.hidden&&!isProcessing&&banner.querySelector('.update-banner')){
      document.removeEventListener('visibilitychange',_autoReload);
      location.reload();
    }
  });
}
async function loadModels(){
  try{
    const{models}=await api("/api/models");
    const dl=$("model-list");dl.innerHTML="";
    models.forEach(m=>{const o=document.createElement("option");o.value=m.id;o.textContent=`${m.name}${m.costInput?` ($${m.costInput}/M in)`:''}`; dl.appendChild(o)});
  }catch{}
}

// --- Integrations ---
let mcpCatalog=[],mcpConfigs=[];

async function loadIntegrations(){
  try{
    const[catalog,configsRes]=await Promise.all([api("/api/mcp-catalog"),api("/api/mcp-configs")]);
    mcpCatalog=Array.isArray(catalog)?catalog:[];
    mcpConfigs=configsRes.configs||[];
    renderIntegrations();
  }catch{$("integrations-list").innerHTML='<div class="empty">Failed to load</div>'}
}

function renderIntegrations(){
  const configMap=new Map(mcpConfigs.map(c=>[c.name.toLowerCase(),c]));
  const getHostname=url=>{try{return new URL(url).hostname;}catch{return null;}};
  const connected=[],suggestions=[];
  mcpCatalog.forEach(cat=>{
    const catHostname=cat.url?getHostname(cat.url):null;
    const configured=configMap.get(cat.name.toLowerCase())
      ||[...configMap.values()].find(c=>catHostname&&c.url&&getHostname(c.url)===catHostname);
    if(configured){
      connected.push(renderIntegCard(cat.name,cat.description,cat.url,configured));
      configMap.delete(configured.name.toLowerCase());
    }else{
      suggestions.push(renderIntegCard(cat.name,cat.description,cat.url,null));
    }
  });
  configMap.forEach(cfg=>{
    connected.push(renderIntegCard(cfg.name,cfg.url||"Custom integration",null,cfg));
  });
  const cards=[...connected,...suggestions];
  $("integrations-list").innerHTML=cards.length?cards.join(""):'<div class="empty">No integrations</div>';
}

function renderIntegCard(name,description,catalogUrl,config){
  const statusHtml=config
    ?`<span class="integ-status" style="color:var(--accent)">Configured</span>`
    :`<span class="integ-status" style="color:var(--muted)">Not configured</span>`;
  let actionsHtml="";
  if(config){
    const checked=config.enabled?"checked":"";
    actionsHtml=`<label class="toggle-switch"><input type="checkbox" ${checked} onchange="toggleIntegration('${esc(config.id)}',this.checked)"/><span class="slider"></span></label><button class="sm" onclick="testIntegration('${esc(config.id)}')">Test</button><button class="sm danger" onclick="deleteIntegration('${esc(config.id)}')">x</button>`;
  }else if(catalogUrl){
    actionsHtml=`<a href="${esc(catalogUrl)}" target="_blank" style="font-size:11px;color:var(--accent)">Setup guide</a>`;
  }
  return `<div class="integ-card"><div class="integ-name">${esc(name)}</div><div class="integ-desc">${esc(description)}</div>${statusHtml}<div class="integ-actions">${actionsHtml}</div></div>`;
}

async function addIntegration(){
  const name=$("integ-name").value.trim();
  const url=$("integ-url").value.trim();
  const authHeader=$("integ-auth-header").value.trim();
  if(!name||!url)return toast("Name and URL are required","warning");
  const body={name,url,type:"http",enabled:true};
  if(authHeader)body.headers={Authorization:authHeader};
  try{
    await json("/api/mcp-configs",body);
    $("integ-name").value="";$("integ-url").value="";$("integ-auth-header").value="";
    await loadIntegrations();
  }catch(e){toast("Failed: "+(e.error||e.message||e),"error")}
}

async function toggleIntegration(id,enabled){
  try{await json(`/api/mcp-configs/${encodeURIComponent(id)}`,{enabled},"PUT");await loadIntegrations()}
  catch(e){toast("Failed: "+(e.message||e),"error")}
}

async function testIntegration(id){
  try{
    const result=await json(`/api/mcp-configs/${encodeURIComponent(id)}/test`,{});
    if(result.ok)toast(`Connection OK — ${result.toolCount} tool${result.toolCount!==1?'s':''} available`,"success");
    else toast(`Connection failed: ${result.error||'Unknown error'}`,"error");
  }catch(e){toast("Test failed: "+(e.message||e),"error")}
}

async function deleteIntegration(id){
  const ok=await appConfirm("Delete this integration?");if(!ok)return;
  await apiSafe(`/api/mcp-configs/${encodeURIComponent(id)}`,{method:"DELETE"});
  await loadIntegrations();
}

// --- Session Settings ---
function showSessionSettings(){
  if(!currentSession)return toast("Select a session first","warning");
  $("settings-overlay").style.display="flex";
  loadSharesList();loadPermissionsList();loadBrowserStatus();loadApprovals();loadSessionMcpConfigs();
}
function hideSessionSettings(){$("settings-overlay").style.display="none"}

async function createShareLink(){
  if(!currentSession)return;
  const permission=$("share-permission").value;
  try{
    const result=await json(`/session/${currentSession}/share`,{permission});
    if(result.token){
      const shareUrl=`${location.origin}/shared/${result.token}`;
      $("share-token-display").style.display="block";
      $("share-token-display").innerHTML=`<strong>Share link (shown once):</strong><br/><a href="${esc(shareUrl)}" target="_blank" style="color:var(--accent)">${esc(shareUrl)}</a>`;
    }
    await loadSharesList();
  }catch(e){toast("Failed: "+(e.message||e),"error")}
}

async function loadSharesList(){
  if(!currentSession)return;
  try{
    const{shares}=await api(`/session/${currentSession}/shares`);
    $("shares-list").innerHTML=(shares||[]).length?(shares||[]).map(s=>`<div class="kv"><span style="font-size:11px">${esc(s.permission)} — ${esc(s.label||'unlabeled')}</span><button class="sm danger" onclick="revokeShare('${esc(s.id)}')">Revoke</button></div>`).join(""):'<div class="empty">No share links</div>';
  }catch{$("shares-list").innerHTML='<div class="empty">No share links</div>'}
}

async function revokeShare(shareId){
  if(!currentSession)return;
  await apiSafe(`/session/${currentSession}/share/${encodeURIComponent(shareId)}`,{method:"DELETE"});
  await loadSharesList();
}

async function loadPermissionsList(){
  if(!currentSession)return;
  try{
    const{permissions}=await api(`/session/${currentSession}/permissions`);
    $("permissions-list").innerHTML=(permissions||[]).length?(permissions||[]).map(p=>`<div class="kv"><span style="font-size:11px">${esc(p.granteeEmail)} — <span class="tag">${esc(p.permission)}</span></span><button class="sm danger" onclick="revokePermission('${esc(p.granteeEmail)}')">Revoke</button></div>`).join(""):'<div class="empty">No permissions granted</div>';
  }catch{$("permissions-list").innerHTML='<div class="empty">No permissions</div>'}
}

async function grantPermission(){
  if(!currentSession)return;
  const email=$("perm-email").value.trim();
  const permission=$("perm-level").value;
  if(!email)return toast("Email is required","warning");
  try{
    await json(`/session/${currentSession}/permissions`,{granteeEmail:email,permission});
    $("perm-email").value="";
    await loadPermissionsList();
  }catch(e){toast("Failed: "+(e.message||e),"error")}
}

async function revokePermission(email){
  if(!currentSession)return;
  await apiSafe(`/session/${currentSession}/permissions/${encodeURIComponent(email)}`,{method:"DELETE"});
  await loadPermissionsList();
}

async function loadBrowserStatus(){
  if(!currentSession)return;
  try{
    const result=await api(`/session/${currentSession}/browser`);
    const enabled=result.enabled??false;
    $("browser-toggle").checked=enabled;
    $("browser-status").textContent=enabled?"Enabled":"Disabled";
  }catch{
    $("browser-toggle").checked=false;
    $("browser-status").textContent="Unavailable";
  }
}

async function toggleBrowser(){
  if(!currentSession)return;
  const enabled=$("browser-toggle").checked;
  try{
    await json(`/session/${currentSession}/browser`,{enabled},"PUT");
    $("browser-status").textContent=enabled?"Enabled":"Disabled";
  }catch(e){
    $("browser-toggle").checked=!enabled;
    toast("Failed: "+(e.message||e),"error");
  }
}

async function loadApprovals(){
  if(!currentSession)return;
  try{
    const{approvals}=await api(`/session/${currentSession}/approvals`);
    const pending=(approvals||[]).filter(a=>a.status==="pending");
    $("approvals-list").innerHTML=pending.length?pending.map(a=>`<div class="approval-card"><div><strong>${esc(a.toolName||a.action||"Action")}</strong></div><div style="color:var(--muted)">${esc(a.description||JSON.stringify(a.args||{}).slice(0,100))}</div><div class="approval-actions"><button class="sm primary" onclick="approveAction('${esc(a.id)}')">Approve</button><button class="sm danger" onclick="rejectAction('${esc(a.id)}')">Reject</button></div></div>`).join(""):'<div class="empty">No pending approvals</div>';
  }catch{$("approvals-list").innerHTML='<div class="empty">No approvals</div>'}
}

async function approveAction(approvalId){
  if(!currentSession)return;
  await jsonSafe(`/session/${currentSession}/approvals/${encodeURIComponent(approvalId)}/approve`,{});
  await loadApprovals();
}

async function rejectAction(approvalId){
  if(!currentSession)return;
  await jsonSafe(`/session/${currentSession}/approvals/${encodeURIComponent(approvalId)}/reject`,{});
  await loadApprovals();
}

// --- Session MCP Config Overrides ---
async function loadSessionMcpConfigs(){
  if(!currentSession)return;
  try{
    const{configs}=await api(`/session/${currentSession}/mcp-configs`);
    $("session-mcp-list").innerHTML=(configs||[]).length?(configs||[]).map(c=>{
      const checked=c.enabled?"checked":"";
      const overrideTag=c.overridden?'<span class="tag">overridden</span>':"";
      return `<div class="kv"><span style="font-size:12px">${esc(c.name)} ${overrideTag}</span><div style="display:flex;gap:6px;align-items:center"><label class="toggle-switch"><input type="checkbox" ${checked} onchange="setSessionMcpOverride('${esc(c.id)}',this.checked)"/><span class="slider"></span></label>${c.overridden?`<button class="sm" onclick="removeSessionMcpOverride('${esc(c.id)}')">Reset</button>`:""}</div></div>`;
    }).join(""):'<div class="empty">No integrations configured</div>';
  }catch{$("session-mcp-list").innerHTML='<div class="empty">Failed to load</div>'}
}

async function setSessionMcpOverride(mcpId,enabled){
  if(!currentSession)return;
  try{
    await json(`/session/${currentSession}/mcp-configs`,{mcpConfigId:mcpId,enabled});
    await loadSessionMcpConfigs();
  }catch(e){toast("Failed: "+(e.message||e),"error")}
}

async function removeSessionMcpOverride(mcpId){
  if(!currentSession)return;
  try{
    await api(`/session/${currentSession}/mcp-configs/${encodeURIComponent(mcpId)}`,{method:"DELETE"});
    await loadSessionMcpConfigs();
  }catch(e){toast("Failed: "+(e.message||e),"error")}
}
