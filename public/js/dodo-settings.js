// dodo-settings.js — Identity, passkeys, secrets, integrations, session settings, permissions, sharing, browser, MCP overrides

// Map of well-known per-user secret keys → human label. Kept in lockstep
// with the <select id="secret-key"> options in index.html plus the keys
// the onboarding wizard and notify.ts read directly (notification_webhooks,
// ntfy_token).
const SECRET_LABELS={
  github_token:"GitHub Token",
  gitlab_token:"GitLab Token",
  gateway_token:"Gateway Token",
  ntfy_topic:"Ntfy Topic",
  ntfy_token:"Ntfy Token",
  notification_webhooks:"Notification Webhooks",
};

// Render a per-user secret key as a human-readable label.
//
// Three shapes to cover:
//   1. mcp:<configId>:<header>  — owned by an MCP integration. Look up the
//      config by id and render "<integration name> — <header>". If the
//      config can't be resolved yet (boot race) OR no longer exists
//      (orphaned secret), fall back to "Unknown MCP (<id-prefix>…) —
//      <header>" so the user can still tell what kind of secret it is.
//   2. well-known plain key (github_token etc.) — render the friendly
//      label from SECRET_LABELS.
//   3. anything else — render verbatim. Future custom keys land here.
function humanizeSecretName(name,configs){
  const m=name.match(/^mcp:([^:]+):(.+)$/);
  if(m){
    const id=m[1],header=m[2];
    const c=configs&&configs.find(x=>x.id===id);
    if(c)return c.name+" \u2014 "+header;
    return"Unknown MCP ("+id.slice(0,8)+"\u2026) \u2014 "+header;
  }
  if(SECRET_LABELS[name])return SECRET_LABELS[name];
  return name;
}

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
    // Use --text-success / --text-danger which are tuned for WCAG AA on
    // both light and dark canvas — the raw --accent (brand violet) at 11px
    // failed Lighthouse contrast on the dark theme (3.78 vs 4.5 required).
    $("passkey-status").innerHTML=initialized?'<div style="font-size:11px;color:var(--text-success)">Passkey configured</div>':'<div style="font-size:11px;color:var(--text-danger)">No passkey set</div>';
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
// Pure renderer: takes the cached secretKeys + mcpConfigs and updates the
// DOM. Split out of loadSecrets() so loadIntegrations() can re-render once
// mcpConfigs arrives, without re-fetching the secrets list. Closes the
// boot-time race that made MCP secrets render as raw "mcp:<uuid>:Authorization"
// for the first paint.
function renderSecretsList(){
  const keys=secretKeys||[];
  $("secrets-list").innerHTML=keys.length
    ?keys.map(k=>`<div class="kv"><code>${esc(humanizeSecretName(k,mcpConfigs))}</code><button onclick="deleteSecret('${esc(k)}')" class="sm">x</button></div>`).join("")
    :'<div class="empty">No secrets</div>';
  // Hide dropdown options for secrets that already exist; hide form entirely if all are set
  const sel=$("secret-key");
  const form=$("secret-add-form");
  if(sel&&form){
    const set=new Set(keys.filter(k=>!k.startsWith("mcp:")));
    let available=0;
    for(const opt of sel.options){opt.disabled=set.has(opt.value);if(!opt.disabled)available++}
    if(!available)form.style.display="none";
    else form.style.display="block";
    for(const opt of sel.options){if(!opt.disabled){sel.value=opt.value;break}}
  }
}

async function loadSecrets(){
  try{
    const{keys}=await api("/api/secrets");
    secretKeys=keys||[];
    renderSecretsList();
    if(mcpCatalog.length)renderIntegrations();
  }catch{secretKeys=[];$("secrets-list").innerHTML='<div class="empty">No secrets</div>'}
}
async function setSecret(){
  const key=$("secret-key").value,value=$("secret-value").value;if(!key||!value)return;
  const r=await jsonSafe(`/api/secrets/${encodeURIComponent(key)}`,{value},"PUT");if(r)toast('Secret saved','success');else toast('Failed to save secret','error');$("secret-value").value="";await loadSecrets()
}
async function deleteSecret(key){await apiSafe(`/api/secrets/${encodeURIComponent(key)}`,{method:"DELETE"});await loadSecrets()}

// --- Status & models ---
let _bootCommit=null;

/** Resolve the current deploy's commit hash — tries /api/status first, falls back to /version.json. */
async function resolveCommit(){
  try{
    const s=await api("/api/status");
    if(s.commit)return{commit:s.commit,version:s.version||''};
  }catch{}
  try{
    const r=await fetch("/version.json",{cache:"no-store"});
    if(r.ok){const v=await r.json();if(v.commit)return{commit:v.commit,version:''}}
  }catch{}
  return{commit:'',version:''};
}

async function loadStatus(){
  try{
    const s=await api("/api/status");
    const{commit}=await resolveCommit();
    const commitStr=commit?` (${esc(commit.slice(0,7))})`:'';
    const versionLabel=`Dodo v${esc(s.version||'?')}${commitStr}`;
    $("footer-text").innerHTML=`<img src="/favicon.svg" alt="" width="14" height="14" style="opacity:.7" class="dodo-logo-img"/> ${versionLabel}`;
    const bv=$("build-version");if(bv)bv.textContent=commit?`build ${esc(commit.slice(0,7))}`:`v${esc(s.version)}`;
    const sv=$("sidebar-version");if(sv)sv.textContent=versionLabel;
    if(!_bootCommit&&commit)_bootCommit=commit;
  }catch{}
}

// Called on SSE reconnect — a deploy restarts the DO, which drops and
// re-establishes the SSE connection.  One fetch on reconnect, zero polling.
// Also catches cases where the Worker was redeployed but the SSE didn't drop
// (e.g. CF Build deploys where the old isolate lingers).
async function checkVersionOnReconnect(){
  if(!_bootCommit)return;
  try{
    const{commit}=await resolveCommit();
    if(commit&&commit!==_bootCommit)showUpdateBanner(commit);
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
    // Filter server-side by the currently selected gateway so the picker never
    // offers a model that would fail on first prompt. Falls back to the saved
    // config's gateway when the UI selector isn't rendered yet.
    const gwSel=$("cfg-gateway");
    let gw=gwSel?gwSel.value:null;
    if(!gw){try{const cfg=await api("/api/config");gw=cfg&&cfg.activeGateway;}catch{}}
    const qs=gw?`?gateway=${encodeURIComponent(gw)}`:"";
    const{models}=await api(`/api/models${qs}`);
    const dl=$("model-list");dl.innerHTML="";
    models.forEach(m=>{const o=document.createElement("option");o.value=m.id;o.textContent=`${m.name}${m.costInput?` ($${m.costInput}/M in)`:''}`; dl.appendChild(o)});
  }catch{}
}

// --- Browser Rendering Config ---

async function loadBrowserConfig(){
  try{
    const cfg=await api("/api/browser-config");
    const el=$("browser-config-status");
    if(cfg.mcpConfigured&&cfg.hasApiToken){
      el.innerHTML=`<span style="color:var(--accent)">\u2705 Connected</span> &mdash; Account: <code>${esc(cfg.cfAccountId||'?')}</code>`;
      $("browser-delete-btn").style.display="inline-block";
      if(cfg.cfAccountId)$("browser-cf-account").value=cfg.cfAccountId;
    }else{
      el.innerHTML='<span style="color:var(--muted)">Not configured</span>';
      $("browser-delete-btn").style.display="none";
    }
  }catch{
    $("browser-config-status").innerHTML='<span style="color:var(--muted)">Not configured</span>';
  }
}

async function saveBrowserConfig(){
  const cfAccountId=$("browser-cf-account").value.trim();
  const cfApiToken=$("browser-cf-token").value.trim();
  if(!cfAccountId||!cfApiToken)return toast("Account ID and API Token are required","warning");
  try{
    await json("/api/browser-config",{cfAccountId,cfApiToken,labMode:false},"PUT");
    $("browser-cf-token").value="";
    $("browser-config-details").open=false;
    toast("Browser Rendering configured","success");
    await loadBrowserConfig();
    await loadIntegrations();
  }catch(e){toast("Failed: "+(e.message||e),"error")}
}

async function deleteBrowserConfig(){
  const ok=await appConfirm("Remove Browser Rendering configuration? This deletes the stored credentials.");
  if(!ok)return;
  try{
    await api("/api/browser-config",{method:"DELETE"});
    toast("Browser config removed","success");
    $("browser-cf-account").value="";
    await loadBrowserConfig();
    await loadIntegrations();
  }catch(e){toast("Failed: "+(e.message||e),"error")}
}

// --- Integrations ---
let mcpCatalog=[],mcpConfigs=[],oauthServers=[],secretKeys=[];

async function loadIntegrations(){
  try{
    // OAuth-MCP servers live in the user's CodingAgent hub DO (keyed by email),
    // not in mcp_configs — they're managed by the Agents SDK. Load them in
    // parallel so the UI can show OAuth catalog entries as "Connected" when
    // the user has already completed the OAuth dance.
    const[catalog,configsRes,oauthRes]=await Promise.all([
      api("/api/mcp-catalog"),
      api("/api/mcp-configs"),
      api("/api/mcp/oauth-servers").catch(()=>({servers:[]})),
    ]);
    mcpCatalog=Array.isArray(catalog)?catalog:[];
    mcpConfigs=configsRes.configs||[];
    oauthServers=oauthRes.servers||[];
    renderIntegrations();
    // Re-render the secrets list now that we know which MCP configs exist —
    // boot-time render may have shown raw "mcp:<uuid>:Authorization" entries
    // because mcpConfigs was still empty when loadSecrets() ran.
    if(secretKeys.length)renderSecretsList();
  }catch{$("integrations-list").innerHTML='<div class="empty">Failed to load</div>'}
}

function renderIntegrations(){
  const configMap=new Map(mcpConfigs.map(c=>[c.name.toLowerCase(),c]));
  const getHostname=url=>{try{return new URL(url).hostname;}catch{return null;}};
  // Match catalog entries to OAuth-connected servers by hostname.
  const oauthByHostname=new Map();
  oauthServers.forEach(s=>{const h=getHostname(s.url);if(h)oauthByHostname.set(h,s);});
  // Track which oauthServers we've rendered as part of a catalog entry so
  // the leftover loop below can pick up the orphans. Without this, a
  // hub-DO record for an MCP URL that's no longer in the catalog (e.g. a
  // failed cf-portal attempt left behind after the catalog entry was
  // removed) would never render → user has no UI handle to clear it.
  const renderedOAuthServerIds=new Set();
  const connected=[],suggestions=[];
  const hasGithubToken=secretKeys.includes("github_token");
  mcpCatalog.forEach(cat=>{
    // Browser Rendering has its own dedicated settings section — skip it here
    if(cat.id==="browser-rendering")return;
    const catHostname=cat.url?getHostname(cat.url):null;
    const catHosts=new Set(cat.knownHosts||[]);
    if(catHostname)catHosts.add(catHostname);
    // OAuth catalog entries: check if the user has a connected OAuth server
    // for any of the known hostnames (the OAuth dance may resolve to a
    // different effective URL than the catalog hint).
    if(cat.auth_type==="oauth"){
      let oauthServer=null;
      for(const h of catHosts){if(oauthByHostname.has(h)){oauthServer=oauthByHostname.get(h);break;}}
      if(oauthServer){
        connected.push(renderOAuthCard(cat,oauthServer));
        renderedOAuthServerIds.add(oauthServer.id);
      }else{
        suggestions.push(renderOAuthCard(cat,null));
      }
      return;
    }
    const configured=configMap.get(cat.name.toLowerCase())
      ||[...configMap.values()].find(c=>c.url&&catHosts.has(getHostname(c.url)));
    if(configured){
      connected.push(renderIntegCard(cat.name,cat.description,cat.url,configured));
      configMap.delete(configured.name.toLowerCase());
    }else{
      // Hide GitHub suggestion when a github_token secret covers git operations
      if(cat.id==="github"&&hasGithubToken)return;
      suggestions.push(renderIntegCard(cat.name,cat.description,cat.url,null));
    }
  });
  configMap.forEach(cfg=>{
    // refresh_token configs need different action affordances — no Test
    // button until /test understands them (it does, post-audit), AND a
    // "Refresh token" button so users don't have to wait for the
    // reconnect-once-on-401 path to fire. See renderRefreshTokenCard.
    if(cfg.auth_type==="refresh_token"){
      connected.push(renderRefreshTokenCard(cfg));
    }else{
      connected.push(renderIntegCard(cfg.name,cfg.url||"Custom integration",null,cfg));
    }
  });
  // Render any orphaned OAuth servers — entries in the per-user hub DO
  // whose URL doesn't match any current catalog entry. Usually leftovers
  // from a failed OAuth attempt where the catalog entry has since been
  // removed, or one-off MCP servers added directly via /api/mcp/start-auth.
  // Surfacing them gives the user a "Clear" button instead of letting the
  // zombie linger.
  oauthServers.forEach(s=>{
    if(renderedOAuthServerIds.has(s.id))return;
    connected.push(renderOrphanedOAuthCard(s));
  });
  const cards=[...connected,...suggestions];
  $("integrations-list").innerHTML=cards.length?cards.join(""):'<div class="empty">No integrations</div>';
}

function renderIntegCard(name,description,catalogUrl,config){
  // --text-success has higher contrast than --accent on the dark canvas
  // (Lighthouse flagged --accent on 10px text at 3.57 vs 4.5 required).
  const statusHtml=config
    ?`<span class="integ-status" style="color:var(--text-success)">Configured</span>`
    :`<span class="integ-status" style="color:var(--text-subtle)">Not configured</span>`;
  let actionsHtml="";
  if(config){
    const checked=config.enabled?"checked":"";
    actionsHtml=`<label class="toggle-switch" aria-label="Enable ${esc(name)}"><span class="visually-hidden">Enable ${esc(name)}</span><input type="checkbox" ${checked} onchange="toggleIntegration('${esc(config.id)}',this.checked)" aria-label="Enable ${esc(name)}"/><span class="slider" aria-hidden="true"></span></label><button class="sm" onclick="testIntegration('${esc(config.id)}')" aria-label="Test ${esc(name)} connection">Test</button><button class="sm danger" onclick="deleteIntegration('${esc(config.id)}')" aria-label="Delete ${esc(name)} integration">x</button>`;
  }else if(catalogUrl){
    actionsHtml=`<a href="${esc(catalogUrl)}" target="_blank" rel="noopener noreferrer" style="font-size:11px;color:var(--text-link)">Setup guide</a>`;
  }
  return `<div class="integ-card"><div class="integ-name">${esc(name)}</div><div class="integ-desc">${esc(description)}</div>${statusHtml}<div class="integ-actions">${actionsHtml}</div></div>`;
}

// refresh_token-MCP integrations (provisioned via set_refresh_token_mcp or
// start_dcr_oauth_flow). Distinct from the SDK-managed OAuth path: the
// access token lives in encrypted_secrets and Dodo refreshes it itself via
// the OAuth token endpoint. Actions:
//   - Enable toggle (just flips the row's `enabled` flag — safe)
//   - Test (now uses the bearer-aware /test endpoint; works post-audit)
//   - Refresh token (force-refresh via /api/mcp-configs/:id/refresh-token,
//     useful when the cached token is dead for reasons other than expiry)
//   - Delete (wipes config + all encrypted secrets for this MCP)
function renderRefreshTokenCard(config){
  const checked=config.enabled?"checked":"";
  const desc=config.url||"Refresh-token MCP integration";
  return `<div class="integ-card"><div class="integ-name">${esc(config.name)}</div><div class="integ-desc">${esc(desc)}</div><span class="integ-status" style="color:var(--text-success)">OAuth · auto-refresh</span><div class="integ-actions"><label class="toggle-switch" aria-label="Enable ${esc(config.name)}"><span class="visually-hidden">Enable ${esc(config.name)}</span><input type="checkbox" ${checked} onchange="toggleIntegration('${esc(config.id)}',this.checked)" aria-label="Enable ${esc(config.name)}"/><span class="slider" aria-hidden="true"></span></label><button class="sm" onclick="testIntegration('${esc(config.id)}')" aria-label="Test ${esc(config.name)} connection">Test</button><button class="sm" onclick="refreshIntegrationToken('${esc(config.id)}','${esc(config.name)}')" aria-label="Refresh ${esc(config.name)} access token">Refresh token</button><button class="sm danger" onclick="deleteIntegration('${esc(config.id)}')" aria-label="Delete ${esc(config.name)} integration">x</button></div></div>`;
}

async function refreshIntegrationToken(id,displayName){
  try{
    const result=await json(`/api/mcp-configs/${encodeURIComponent(id)}/refresh-token`,{});
    if(result.accessToken){
      toast(`${displayName} token refreshed`,"success");
    }else if(result.error){
      toast(`Refresh failed: ${result.error}`,"error");
    }else{
      toast(`Refresh failed: unexpected response`,"error");
    }
  }catch(e){toast("Refresh failed: "+(e.message||e),"error")}
}

// OAuth-MCP catalog entries render with different actions based on the
// server's current state in the per-user hub DO. The Agents SDK transitions
// between authenticating → connecting → discovering → ready (success path)
// or → failed (terminal error). For terminal states the only sensible
// action is to clear the entry; offering "Refresh" on a failed server
// retries against the same broken config and confuses users.
function renderOAuthCard(cat,server){
  const desc=cat.description||"";
  let statusHtml,actionsHtml;
  if(server){
    const stateLabel=server.state==="ready"?`Connected — ${server.toolCount} tool${server.toolCount!==1?'s':''}`
      :server.state==="authenticating"?"Authenticating…"
      :server.state==="connecting"?"Connecting…"
      :server.state==="discovering"?"Discovering…"
      :server.state==="failed"?(server.error?`Failed: ${server.error}`:"Failed")
      :server.state;
    const color=server.state==="ready"?"var(--text-success)":server.state==="failed"?"var(--text-error,#b91c1c)":"var(--text-subtle)";
    statusHtml=`<span class="integ-status" style="color:${color}">${esc(stateLabel)}</span>`;
    const isReady=server.state==="ready";
    const refreshBtn=isReady?`<button class="sm" onclick="refreshOAuthServer('${esc(server.id)}')" aria-label="Refresh ${esc(cat.name)} connection">Refresh</button>`:"";
    const removeLabel=isReady?"Disconnect":"Clear";
    actionsHtml=`${refreshBtn}<button class="sm danger" onclick="disconnectOAuthServer('${esc(server.id)}','${esc(cat.name)}')" aria-label="${esc(removeLabel)} ${esc(cat.name)}">${removeLabel}</button>`;
  }else{
    statusHtml=`<span class="integ-status" style="color:var(--text-subtle)">Not connected</span>`;
    actionsHtml=`<button class="sm primary" onclick="connectOAuthCatalog('${esc(cat.id)}','${esc(cat.url)}')" aria-label="Connect ${esc(cat.name)} with OAuth">Connect with OAuth</button>`;
  }
  return `<div class="integ-card"><div class="integ-name">${esc(cat.name)}</div><div class="integ-desc">${esc(desc)}</div>${statusHtml}<div class="integ-actions">${actionsHtml}</div></div>`;
}

// Render an OAuth server that has no matching catalog entry — either a
// custom MCP added via `/api/mcp/start-auth`, or a leftover from a failed
// attempt whose catalog entry has since been removed. Always offer a
// "Clear" action so the user can wipe it; never offer "Refresh" since we
// don't know what the original setup looked like.
function renderOrphanedOAuthCard(server){
  const stateLabel=server.state==="ready"?`Connected — ${server.toolCount} tool${server.toolCount!==1?'s':''}`
    :server.state==="authenticating"?"Authenticating… (no longer reachable)"
    :server.state==="failed"?(server.error?`Failed: ${server.error}`:"Failed")
    :server.state;
  const color=server.state==="ready"?"var(--text-success)":server.state==="failed"?"var(--text-error,#b91c1c)":"var(--text-subtle)";
  const displayName=server.name||"OAuth MCP";
  const desc=`${server.url} — orphaned entry, not in catalog`;
  return `<div class="integ-card"><div class="integ-name">${esc(displayName)}</div><div class="integ-desc">${esc(desc)}</div><span class="integ-status" style="color:${color}">${esc(stateLabel)}</span><div class="integ-actions"><button class="sm danger" onclick="disconnectOAuthServer('${esc(server.id)}','${esc(displayName)}')" aria-label="Clear ${esc(displayName)}">Clear</button></div></div>`;
}

// Kick off the OAuth dance for a catalog entry. The server returns either
// {authUrl} (popup needed) or {message:"Connected"} (already authenticated).
// The popup polls /api/mcp/oauth-servers after closing to detect the new
// connection.
async function connectOAuthCatalog(catalogId,mcpUrl){
  try{
    const result=await json("/api/mcp/start-auth",{mcpUrl});
    if(result.authUrl){
      const popup=window.open(result.authUrl,"dodo-oauth","width=560,height=720,menubar=no,toolbar=no");
      if(!popup){
        toast("Popup blocked. Allow popups for this site and try again.","error");
        return;
      }
      // Poll for popup close + server-side connection — the Agents SDK
      // handles the callback at /agents/coding-agent/<userId-hex>/callback
      // (see api/mcp/start-auth in src/index.ts for why the path is shaped
      // this way) and updates the hub DO's `getMcpServers()` state. We
      // can't postMessage from the OAuth provider's domain, so we poll
      // the popup's closed state and then refresh the integrations list.
      const startedAt=Date.now();
      const poll=setInterval(async()=>{
        try{
          if(popup.closed){clearInterval(poll);await loadIntegrations();return;}
          if(Date.now()-startedAt>5*60*1000){
            clearInterval(poll);try{popup.close();}catch{}
            toast("OAuth flow timed out","warning");
            await loadIntegrations();
          }
        }catch{/* cross-origin while on provider — ignore */}
      },800);
    }else{
      toast(`Connected to ${catalogId}`,"success");
      await loadIntegrations();
    }
  }catch(e){toast("Failed to start OAuth: "+(e.error||e.message||e),"error")}
}

async function disconnectOAuthServer(mcpId,displayName){
  const ok=await appConfirm(`Disconnect ${displayName}?`);
  if(!ok)return;
  try{
    await json("/api/mcp/delete-auth",{mcpId});
    toast(`Disconnected ${displayName}`,"success");
    await loadIntegrations();
  }catch(e){toast("Disconnect failed: "+(e.error||e.message||e),"error")}
}

async function refreshOAuthServer(mcpId){
  try{
    await json("/api/mcp/refresh-state",{mcpId});
    await loadIntegrations();
  }catch(e){toast("Refresh failed: "+(e.error||e.message||e),"error")}
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
  // Server-side delete also wipes the integration's mcp:<id>:* secrets, so
  // refresh the secrets list too. Otherwise the UI keeps showing them as
  // orphans until the next page load.
  await Promise.all([loadIntegrations(),loadSecrets()]);
}

// --- Session Settings ---
function showSessionSettings(){
  if(!currentSession)return toast("Select a session first","warning");
  const o=$("settings-overlay");
  o.style.display="flex";
  trapFocus(o);
  loadSharesList();loadPermissionsList();loadBrowserStatus();loadSessionMcpConfigs();
}
function hideSessionSettings(){const o=$("settings-overlay");releaseFocus(o);o.style.display="none"}

async function createShareLink(){
  if(!currentSession)return;
  const permission=$("share-permission").value;
  try{
    const result=await json(`/session/${currentSession}/share`,{permission});
    if(result.token){
      const shareUrl=`${location.origin}/shared/${result.token}`;
      const display=$("share-token-display");
      display.style.display="block";
      display.innerHTML=`<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><strong style="flex:1">Share link (shown once)</strong><button class="sm" id="copy-share-btn" style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap"><i class="ph ph-copy"></i> Copy</button></div><span style="color:var(--accent);user-select:all">${esc(shareUrl)}</span>`;
      $("copy-share-btn").onclick=()=>{navigator.clipboard.writeText(shareUrl).then(()=>{const b=$("copy-share-btn");b.innerHTML='<i class="ph ph-check"></i> Copied!';b.classList.add('primary');setTimeout(()=>{b.innerHTML='<i class="ph ph-copy"></i> Copy';b.classList.remove('primary')},2000)})};
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
    const enabled=result.browserEnabled??false;
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

// --- Session MCP Config Overrides ---
//
// Renders the per-session MCP toggle list. We also fetch the live
// `/mcp-status` data — populated by connectMcpServers() inside the
// CodingAgent DO — so the row can show whether the last connect
// attempt actually succeeded. Status is empty until the session
// processes its first message (DOs are lazy).
async function loadSessionMcpConfigs(){
  if(!currentSession)return;
  try{
    // Fetch both in parallel. mcp-status can legitimately 404 / be empty
    // on a freshly-created session, so swallow the error there.
    const[configsRes,statusRes]=await Promise.all([
      api(`/session/${currentSession}/mcp-configs`),
      api(`/session/${currentSession}/mcp-status`).catch(()=>({statuses:[]})),
    ]);
    const configs=configsRes.configs||[];
    const statusMap=new Map((statusRes.statuses||[]).map(s=>[s.id,s]));
    $("session-mcp-list").innerHTML=configs.length?configs.map(c=>{
      const checked=c.enabled?"checked":"";
      const overrideTag=c.overridden?'<span class="tag">overridden</span>':"";
      const status=statusMap.get(c.id);
      const statusPill=renderMcpStatusPill(c,status);
      return `<div class="kv"><span style="font-size:12px;display:flex;align-items:center;gap:6px">${esc(c.name)} ${statusPill} ${overrideTag}</span><div style="display:flex;gap:6px;align-items:center"><label class="toggle-switch"><input type="checkbox" ${checked} onchange="setSessionMcpOverride('${esc(c.id)}',this.checked)"/><span class="slider"></span></label>${c.overridden?`<button class="sm" onclick="removeSessionMcpOverride('${esc(c.id)}')">Reset</button>`:""}</div></div>`;
    }).join(""):'<div class="empty">No integrations configured</div>';
  }catch{$("session-mcp-list").innerHTML='<div class="empty">Failed to load</div>'}
}

// Pure renderer for the per-MCP status pill. Three states:
//   - never tried (no entry in statusMap) → grey "—"
//   - ok          → green "✓ N tools"
//   - failed      → red "✗" with error in title attr (hover tooltip)
// Disabled configs render a muted "off" pill regardless of last-seen
// status, because the session won't have tried to connect.
function renderMcpStatusPill(config,status){
  if(!config.enabled){
    return `<span class="mcp-status mcp-status-off" title="Disabled — won't connect this session">off</span>`;
  }
  if(!status){
    return `<span class="mcp-status mcp-status-pending" title="No connect attempt yet — send a message to trigger">—</span>`;
  }
  if(status.ok){
    const n=Number(status.toolCount||0);
    return `<span class="mcp-status mcp-status-ok" title="Last connect ok — ${n} tool${n===1?"":"s"}">✓ ${n}</span>`;
  }
  const err=String(status.error||"unknown error");
  return `<span class="mcp-status mcp-status-fail" title="${esc(err)}">✗</span>`;
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

// --- Skills & Tools catalog ---
async function loadSkillsAndTools(){
  const skillsEl=$("skills-list");
  const toolsEl=$("tool-catalog-list");
  if(!skillsEl&&!toolsEl)return;
  try{
    const[skillsRes,toolsRes]=await Promise.all([
      api("/api/skills/all").catch(()=>({skills:[]})),
      api("/api/tool-catalog").catch(()=>({orchestrator:[]})),
    ]);
    renderSkillCatalog(skillsRes.skills||[]);
    renderToolCatalog(toolsRes.orchestrator||[]);
  }catch(e){
    if(skillsEl)skillsEl.innerHTML='<div class="empty">Failed to load skills</div>';
    if(toolsEl)toolsEl.innerHTML='<div class="empty">Failed to load tools</div>';
  }
}

function renderSkillCatalog(skills){
  const el=$("skills-list");if(!el)return;
  if(!skills.length){el.innerHTML='<div class="empty">No skills available</div>';return}
  // Group: built-in vs personal
  const groups={builtin:[],personal:[]};
  for(const s of skills){(groups[s.source]||groups.personal).push(s)}
  const renderRow=s=>{
    const badge=s.source==="builtin"
      ?'<span class="integ-status" style="color:var(--text-subtle);font-size:10px">built-in</span>'
      :`<span class="integ-status" style="color:${s.enabled?'var(--text-success)':'var(--text-subtle)'};font-size:10px">${s.enabled?'enabled':'disabled'}</span>`;
    return `<div class="integ-card"><div class="integ-name">${esc(s.name)}</div><div class="integ-desc">${esc(s.description||"")}</div>${badge}</div>`;
  };
  const sections=[];
  if(groups.personal.length){
    sections.push(`<div style="font-size:11px;color:var(--text-subtle);margin:6px 0 4px">Personal (${groups.personal.length})</div>${groups.personal.map(renderRow).join("")}`);
  }
  if(groups.builtin.length){
    sections.push(`<div style="font-size:11px;color:var(--text-subtle);margin:6px 0 4px">Built-in (${groups.builtin.length})</div>${groups.builtin.map(renderRow).join("")}`);
  }
  el.innerHTML=sections.join("");
}

function renderToolCatalog(tools){
  const el=$("tool-catalog-list");if(!el)return;
  if(!tools.length){el.innerHTML='<div class="empty">No tools available</div>';return}
  // Group by category for readability
  const order=["subagent","discovery","files","edit","planning","skill","execution","browser","git"];
  const labels={subagent:"Subagents",discovery:"Discovery",files:"Files",edit:"Edit",planning:"Planning",skill:"Skills",execution:"Execution",browser:"Browser",git:"Git"};
  const byCat={};
  for(const t of tools){(byCat[t.category]=byCat[t.category]||[]).push(t)}
  const sections=order.filter(c=>byCat[c]&&byCat[c].length).map(cat=>{
    const items=byCat[cat].map(t=>{
      const dim=t.alwaysOn?"":";opacity:0.6";
      const caveat=t.caveat?` <span style="color:var(--text-subtle);font-style:italic">(${esc(t.caveat)})</span>`:"";
      return `<div class="integ-card" style="padding:6px 8px${dim}"><div style="display:flex;align-items:baseline;gap:6px"><code style="font-family:var(--mono);font-size:12px">${esc(t.name)}</code>${t.alwaysOn?"":'<span class="integ-status" style="font-size:10px;color:var(--text-subtle)">off</span>'}</div><div class="integ-desc" style="margin-top:2px">${esc(t.description)}${caveat}</div></div>`;
    }).join("");
    return `<div style="font-size:11px;color:var(--text-subtle);margin:6px 0 4px">${labels[cat]||cat}</div>${items}`;
  });
  el.innerHTML=sections.join("");
}
