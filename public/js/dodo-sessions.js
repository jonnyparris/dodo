// dodo-sessions.js — Session list, select, filter, onboarding sessions

let userEventSource=null;

let _sessionsLoaded=false;
async function loadSessions(){
  const el=$("session-list");
  // Only show skeleton on first load — SSE refreshes should be seamless
  if(!_sessionsLoaded)showSkeleton(el,4);
  const d=await apiSafe("/session");if(!d)return;const{sessions}=d;
  allSessions=sessions;
  renderSessionList(sessions);
  _sessionsLoaded=true;
}

/** Connect to user-level SSE for real-time session list updates. */
function connectUserEvents(){
  if(userEventSource)userEventSource.close();
  userEventSource=new EventSource("/api/events");
  userEventSource.onopen=()=>{checkVersionOnReconnect()};
  userEventSource.addEventListener("sessions_changed",()=>{loadSessions()});
  userEventSource.onerror=()=>{
    // Reconnect after a delay if the connection drops
    if(userEventSource&&userEventSource.readyState===EventSource.CLOSED){
      setTimeout(connectUserEvents,5000);
    }
  };
}
function _sessionItemHtml(s){
  // Both Enter and Space must activate `role=button` elements (ARIA spec).
  // preventDefault() on Space stops the page from scrolling.
  // No `aria-label` — when set, AT announces only the label and skips inner
  // text, which would hide the `.session-meta` status + timestamp. Letting
  // accessible-name computation fall through to the title + meta children
  // matches what sighted users see.
  return `<div class="session-item ${currentSession===s.id?'active':''}" data-sid="${esc(s.id)}" onclick="selectSession('${esc(s.id)}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectSession('${esc(s.id)}')}"><div class="session-title">${esc(s.title||s.id.slice(0,8))}</div><div class="session-meta">${esc(s.status)} &middot; ${esc(new Date(s.updatedAt).toLocaleString())}</div></div>`
}
function renderSessionList(sessions){
  const el=$("session-list");
  if(!sessions.length){el.innerHTML='<div class="empty">No sessions yet</div>';return}
  // Targeted update: patch existing items instead of replacing the entire list.
  // This prevents flicker on SSE-triggered refreshes.
  const existingItems=el.querySelectorAll(".session-item[data-sid]");
  if(existingItems.length>0){
    const sessionMap=new Map(sessions.map(s=>[s.id,s]));
    const existingIds=new Set();
    // Update existing items in place
    existingItems.forEach(item=>{
      const sid=item.getAttribute("data-sid");
      existingIds.add(sid);
      const s=sessionMap.get(sid);
      if(!s){item.remove();return}
      // Update active state
      item.classList.toggle("active",currentSession===sid);
      // Update title and meta
      const titleEl=item.querySelector(".session-title");
      const metaEl=item.querySelector(".session-meta");
      const newTitle=s.title||sid.slice(0,8);
      const newMeta=`${s.status} \u00b7 ${new Date(s.updatedAt).toLocaleString()}`;
      if(titleEl&&titleEl.textContent!==newTitle)titleEl.textContent=newTitle;
      if(metaEl&&metaEl.textContent!==newMeta)metaEl.textContent=newMeta;
    });
    // Prepend new sessions that don't exist in the DOM yet
    sessions.forEach((s,i)=>{
      if(!existingIds.has(s.id)){
        const tmp=document.createElement("div");
        tmp.innerHTML=_sessionItemHtml(s);
        const node=tmp.firstElementChild;
        const ref=el.children[i];
        if(ref)el.insertBefore(node,ref);else el.appendChild(node);
      }
    });
  }else{
    // Cold render — no existing items
    el.innerHTML=sessions.map(s=>_sessionItemHtml(s)).join("");
  }
}
function filterSessions(query){
  if(!query){renderSessionList(allSessions);return}
  const q=query.toLowerCase();
  const filtered=allSessions.filter(s=>(s.title||s.id).toLowerCase().includes(q));
  renderSessionList(filtered);
}
async function createSession(){const d=await jsonSafe("/session",{});if(!d)return;const{id}=d;currentSession=id;await selectSession(id)}

// ===== Pre-session picker =====
//
// In-memory state. Each entry is `{ name|id, label, source?, enabled }`. The
// `enabled` flag tracks what the user has toggled in the picker; on submit
// we send only the disabled entries (and any explicitly-on overrides) as
// `skillOverrides` / `mcpOverrides` to POST /session.
const _picker = { skills: [], mcps: [] };

async function openSessionPicker(){
  const overlay = document.getElementById("picker-overlay");
  if (!overlay) return;
  // Always pre-fill from last-session prefs so "Remember last session's
  // selection" is the visible default.
  await pickerLoadAvailable();
  await pickerLoadLast({ silent: true });
  overlay.style.display = "flex";
}

function closeSessionPicker(){
  const overlay = document.getElementById("picker-overlay");
  if (!overlay) return;
  overlay.style.display = "none";
}

async function pickerLoadAvailable(){
  // /api/skills/all returns personal + builtin (workspace is per-session
  // and not visible before clone). /api/mcp-configs returns user MCPs.
  const [skillsRes, mcpRes] = await Promise.all([
    apiSafe("/api/skills/all"),
    apiSafe("/api/mcp-configs"),
  ]);
  const skills = (skillsRes?.skills ?? []).map((s) => ({
    name: s.name,
    description: s.description || "",
    source: s.source,
    enabled: s.enabled !== false,
  }));
  const mcps = (mcpRes?.configs ?? mcpRes?.mcpConfigs ?? mcpRes ?? []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    description: m.description || m.url || "",
    enabled: m.enabled !== false,
  }));
  _picker.skills = skills;
  _picker.mcps = mcps;
  renderPickerLists();
}

async function pickerLoadLast(opts){
  const prefs = await apiSafe("/api/session-preferences");
  if (!prefs) {
    if (!opts?.silent) toast("No prior selection found", "info");
    return;
  }
  const skillMap = new Map((prefs.skillOverrides || []).map((o) => [o.skillName, o.enabled]));
  const mcpMap = new Map((prefs.mcpOverrides || []).map((o) => [o.mcpConfigId, o.enabled]));
  for (const s of _picker.skills) {
    if (skillMap.has(s.name)) s.enabled = skillMap.get(s.name);
  }
  for (const m of _picker.mcps) {
    if (mcpMap.has(m.id)) m.enabled = mcpMap.get(m.id);
  }
  renderPickerLists();
}

function pickerSelectAll(){
  for (const s of _picker.skills) s.enabled = true;
  for (const m of _picker.mcps) m.enabled = true;
  renderPickerLists();
}
function pickerSelectNone(){
  for (const s of _picker.skills) s.enabled = false;
  for (const m of _picker.mcps) m.enabled = false;
  renderPickerLists();
}

function renderPickerLists(){
  const filter = (document.getElementById("picker-filter")?.value || "").toLowerCase();
  const matches = (label, desc) => !filter || (label || "").toLowerCase().includes(filter) || (desc || "").toLowerCase().includes(filter);

  const skillsHost = document.getElementById("picker-skills");
  const mcpsHost = document.getElementById("picker-mcps");
  if (!skillsHost || !mcpsHost) return;

  const skillRows = _picker.skills.filter((s) => matches(s.name, s.description)).map((s, i) => {
    const idx = _picker.skills.indexOf(s);
    const sourceLabel = s.source ? `<span style="font-size:10px;color:var(--muted);margin-left:6px">[${esc(s.source)}]</span>` : "";
    return `<label class="picker-row" style="display:flex;align-items:flex-start;gap:8px;padding:4px 2px;font-size:12px;cursor:pointer">
      <input type="checkbox" ${s.enabled ? "checked" : ""} onchange="_picker.skills[${idx}].enabled=this.checked"/>
      <span style="flex:1;min-width:0">
        <span style="font-weight:500">${esc(s.name)}</span>${sourceLabel}
        <span style="display:block;color:var(--muted);font-size:11px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${esc((s.description || "").slice(0, 200))}</span>
      </span>
    </label>`;
  });
  const mcpRows = _picker.mcps.filter((m) => matches(m.name, m.description)).map((m) => {
    const idx = _picker.mcps.indexOf(m);
    return `<label class="picker-row" style="display:flex;align-items:flex-start;gap:8px;padding:4px 2px;font-size:12px;cursor:pointer">
      <input type="checkbox" ${m.enabled ? "checked" : ""} onchange="_picker.mcps[${idx}].enabled=this.checked"/>
      <span style="flex:1;min-width:0">
        <span style="font-weight:500">${esc(m.name)}</span>
        <span style="display:block;color:var(--muted);font-size:11px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${esc((m.description || "").slice(0, 200))}</span>
      </span>
    </label>`;
  });

  const skillSelected = _picker.skills.filter((s) => s.enabled).length;
  const mcpSelected = _picker.mcps.filter((m) => m.enabled).length;
  document.getElementById("picker-skill-count").textContent = `${skillSelected}/${_picker.skills.length} on`;
  document.getElementById("picker-mcp-count").textContent = `${mcpSelected}/${_picker.mcps.length} on`;
  skillsHost.innerHTML = skillRows.length ? skillRows.join("") : '<div style="color:var(--muted);font-size:12px">No matches</div>';
  mcpsHost.innerHTML = mcpRows.length ? mcpRows.join("") : '<div style="color:var(--muted);font-size:12px">No MCPs configured</div>';
}

async function createSessionFromPicker(){
  const skillOverrides = _picker.skills.map((s) => ({ skillName: s.name, enabled: s.enabled }));
  const mcpOverrides = _picker.mcps.map((m) => ({ mcpConfigId: m.id, enabled: m.enabled }));
  const d = await jsonSafe("/session", { skillOverrides, mcpOverrides });
  if (!d) { toast("Failed to create session", "error"); return; }
  closeSessionPicker();
  const { id } = d;
  currentSession = id;
  await selectSession(id);
}
async function selectSession(id){
  currentSession=id;setProcessing(false);_gitRemoteUrlCache='';history.replaceState(null,"",`#session=${id}`);
  // Drop any staged image attachments from the previous session — they belong
  // to whatever the user was about to send there, not here.
  if(typeof clearPendingImages==='function')clearPendingImages();
  $("chat").innerHTML="";$("onboarding")?.remove();
  if(typeof hideContextWarning==='function')hideContextWarning();
  showSkeleton($("chat"),5);
  $("session-id-display").textContent=id.slice(0,8);
  $("session-title-display").textContent=id.slice(0,8);
  // Clear stale todos from the previous session immediately so users don't
  // see a flash of the wrong list while the new session loads.
  if(typeof renderSessionTodos==='function')renderSessionTodos([]);
  const [,state,msgData]=await Promise.all([
    loadSessions(),
    apiSafe(`/session/${id}`),
    apiSafe(`/session/${id}/messages`),
    loadFiles("/"),loadCron(),refreshGit(),
    typeof loadWatchdog==='function'?loadWatchdog():Promise.resolve(),
    typeof loadSessionTodos==='function'?loadSessionTodos():Promise.resolve()
  ]);
  $("chat").innerHTML="";
  if(!state&&!msgData){
    const el=document.createElement("div");el.className="msg error";
    el.textContent="Failed to load session. Check your connection and try again.";
    $("chat").appendChild(el);return;
  }
  if(state){$("session-title-display").textContent=state.title||id.slice(0,8);setStatusDot(state.status);updateTokenSummary(state);if(state.status==="running")setProcessing(true)}
  if(msgData){const{messages}=msgData;messages.forEach(renderMessage);requestAnimationFrame(()=>{const c=$("chat");c.scrollTop=c.scrollHeight})}
  else{const el=document.createElement("div");el.className="msg error";el.textContent="Couldn\u2019t load messages. They may appear once the connection recovers.";$("chat").appendChild(el)}
  connectSSE(id);connectWebSocket(id);
  if(window.innerWidth<=900)switchTab('chat');
}

async function clearOtherSessions(){
  const others=allSessions.filter(s=>s.id!==currentSession);
  if(!others.length){toast('No other sessions to delete','info');return}
  const ok=await appConfirm(`Delete ${others.length} other session${others.length>1?'s':''}? The current session will be kept.`);
  if(!ok)return;
  let deleted=0;
  for(const s of others){
    try{await apiSafe(`/session/${s.id}`,{method:"DELETE"});deleted++}catch{}
  }
  toast(`Deleted ${deleted} session${deleted>1?'s':''}`,'success');
  await loadSessions();
}

function renderOnboardingSessions(){
  const container=$('onboarding-sessions');
  const list=$('onboarding-session-list');
  if(!container||!list||!allSessions.length)return;
  container.classList.add('has-sessions');
  const recent=allSessions.slice(0,4);
  // Use <button> for the same reason as example prompts: keyboard
  // accessibility. The .example-prompt CSS class already handles the
  // visual reset (width, text-align, colors).
  list.innerHTML=recent.map(s=>{const id=esc(s.id);const title=esc(s.title||s.id.slice(0,8));return `<button type="button" class="example-prompt" onclick="selectSession('${id}')" aria-label="Open session: ${title}"><strong>${title}</strong><div style="font-size:11px;color:var(--muted);margin-top:2px">${esc(s.status)} &middot; ${esc(new Date(s.updatedAt).toLocaleString())}</div></button>`}).join('');
}
