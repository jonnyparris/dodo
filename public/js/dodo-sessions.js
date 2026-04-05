// dodo-sessions.js — Session list, select, filter, onboarding sessions

let userEventSource=null;

async function loadSessions(){
  const el=$("session-list");
  showSkeleton(el,4);
  const d=await apiSafe("/session");if(!d)return;const{sessions}=d;
  allSessions=sessions;
  renderSessionList(sessions);
}

/** Connect to user-level SSE for real-time session list updates. */
function connectUserEvents(){
  if(userEventSource)userEventSource.close();
  userEventSource=new EventSource("/api/events");
  userEventSource.addEventListener("sessions_changed",()=>{loadSessions()});
  userEventSource.onerror=()=>{
    // Reconnect after a delay if the connection drops
    if(userEventSource&&userEventSource.readyState===EventSource.CLOSED){
      setTimeout(connectUserEvents,5000);
    }
  };
}
function renderSessionList(sessions){
  const el=$("session-list");
  if(!sessions.length){el.innerHTML='<div class="empty">No sessions yet</div>';return}
  el.innerHTML=sessions.map(s=>`<div class="session-item ${currentSession===s.id?'active':''}" onclick="selectSession('${esc(s.id)}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter')selectSession('${esc(s.id)}')"><div class="session-title">${esc(s.title||s.id.slice(0,8))}</div><div class="session-meta">${esc(s.status)} &middot; ${esc(new Date(s.updatedAt).toLocaleString())}</div></div>`).join("")
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
  $("chat").innerHTML="";$("onboarding")?.remove();
  const cw=$("context-warning");if(cw)cw.style.display="none";
  showSkeleton($("chat"),5);
  $("session-id-display").textContent=id.slice(0,8);
  $("session-title-display").textContent=id.slice(0,8);
  const [,state,msgData]=await Promise.all([
    loadSessions(),
    apiSafe(`/session/${id}`),
    apiSafe(`/session/${id}/messages`),
    loadFiles("/"),loadCron(),refreshGit()
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

function renderOnboardingSessions(){
  const container=$('onboarding-sessions');
  const list=$('onboarding-session-list');
  if(!container||!list||!allSessions.length)return;
  container.classList.add('has-sessions');
  const recent=allSessions.slice(0,4);
  list.innerHTML=recent.map(s=>`<div class="example-prompt" onclick="selectSession('${esc(s.id)}')"><strong>${esc(s.title||s.id.slice(0,8))}</strong><div style="font-size:11px;color:var(--muted);margin-top:2px">${esc(s.status)} &middot; ${esc(new Date(s.updatedAt).toLocaleString())}</div></div>`).join('');
}
