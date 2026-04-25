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
  return `<div class="session-item ${currentSession===s.id?'active':''}" data-sid="${esc(s.id)}" onclick="selectSession('${esc(s.id)}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter')selectSession('${esc(s.id)}')"><div class="session-title">${esc(s.title||s.id.slice(0,8))}</div><div class="session-meta">${esc(s.status)} &middot; ${esc(new Date(s.updatedAt).toLocaleString())}</div></div>`
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
async function selectSession(id){
  currentSession=id;setProcessing(false);_gitRemoteUrlCache='';history.replaceState(null,"",`#session=${id}`);
  // Drop any staged image attachments from the previous session — they belong
  // to whatever the user was about to send there, not here.
  if(typeof clearPendingImages==='function')clearPendingImages();
  $("chat").innerHTML="";$("onboarding")?.remove();
  const cw=$("context-warning");if(cw)cw.style.display="none";
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
  list.innerHTML=recent.map(s=>`<div class="example-prompt" onclick="selectSession('${esc(s.id)}')"><strong>${esc(s.title||s.id.slice(0,8))}</strong><div style="font-size:11px;color:var(--muted);margin-top:2px">${esc(s.status)} &middot; ${esc(new Date(s.updatedAt).toLocaleString())}</div></div>`).join('');
}
