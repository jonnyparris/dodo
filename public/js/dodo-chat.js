// dodo-chat.js — Markdown rendering, SSE, streaming, messages, chat actions, presence

// Markdown rendering for assistant messages
let _markedConfigured=false;
function renderMarkdown(text){
  if(typeof marked==="undefined")return esc(text);
  if(!_markedConfigured){marked.setOptions({breaks:true,gfm:true});_markedConfigured=true}
  try{return marked.parse(text)}catch{return esc(text)}
}

// Incremental markdown streaming
let streamingText="";
let streamingRenderTimer=null;
function renderStreamingMarkdown(){
  if(!streamingEl)return;
  streamingEl.innerHTML=renderMarkdown(streamingText);
  streamingEl.querySelectorAll('pre').forEach(pre=>{pre.style.position='relative'});
  $("chat").scrollTop=$("chat").scrollHeight;
}

// --- SSE ---
function connectSSE(id){
  if(eventSource)eventSource.close();eventSource=new EventSource(`/session/${id}/events`);
  eventSource.onopen=()=>{$("sse-banner").classList.remove("visible")};
  eventSource.onerror=()=>{if(eventSource.readyState===EventSource.CLOSED){$("sse-banner").classList.add("visible")}else if(eventSource.readyState===EventSource.CONNECTING){$("sse-banner").classList.add("visible")}};
  eventSource.addEventListener("text_delta",(e)=>{resetSseActivityTimer();hideThinking();const{delta}=JSON.parse(e.data);if(!streamingEl){streamingEl=document.createElement("div");streamingEl.className="msg assistant";streamingEl.textContent="";streamingText="";$("chat").appendChild(streamingEl)}streamingText+=delta;if(!streamingRenderTimer){streamingRenderTimer=setTimeout(()=>{streamingRenderTimer=null;renderStreamingMarkdown()},80)}});
  eventSource.addEventListener("message",(e)=>{resetSseActivityTimer();hideThinking();const msg=JSON.parse(e.data);if(streamingRenderTimer){clearTimeout(streamingRenderTimer);streamingRenderTimer=null}streamingText="";if(streamingEl){streamingEl.innerHTML=renderMarkdown(msg.content);
    streamingEl.querySelectorAll('pre').forEach(pre=>{const btn=document.createElement('button');btn.className='copy-code';btn.textContent='Copy';btn.onclick=(ev)=>{ev.stopPropagation();const code=pre.querySelector('code')?.textContent||pre.textContent;navigator.clipboard.writeText(code).then(()=>{btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy',1500)})};pre.style.position='relative';pre.appendChild(btn)});
    const actions=document.createElement("div");actions.className="msg-actions";const copyBtn=document.createElement("button");copyBtn.textContent="Copy";copyBtn.title="Copy message";copyBtn.setAttribute("aria-label","Copy message");copyBtn.onclick=()=>{navigator.clipboard.writeText(msg.content).then(()=>{copyBtn.textContent="Copied!";setTimeout(()=>copyBtn.textContent="Copy",1500)})};actions.appendChild(copyBtn);streamingEl.appendChild(actions);
    if(msg.tokenInput||msg.tokenOutput){const m=document.createElement("div");m.style.cssText="font-size:10px;color:var(--muted);margin-top:6px;opacity:.7";m.textContent=`${msg.tokenInput??0} in / ${msg.tokenOutput??0} out`;streamingEl.appendChild(m)}streamingEl=null}else{renderMessage(msg)}loadFilesDebounced();apiSafe(`/session/${id}`).then(s=>{if(s)updateTokenSummary(s)})});
  eventSource.addEventListener("state",(e)=>{resetSseActivityTimer();const s=JSON.parse(e.data);setStatusDot(s.status);updateTokenSummary(s);if(s.status!=="running"){setProcessing(false);hideThinking();if(streamingRenderTimer){clearTimeout(streamingRenderTimer);streamingRenderTimer=null}streamingText="";streamingEl=null;loadPrompts()}});
  eventSource.addEventListener("tool_call",(e)=>{resetSseActivityTimer();hideThinking();if(streamingEl){if(streamingRenderTimer){clearTimeout(streamingRenderTimer);streamingRenderTimer=null}if(streamingText){renderStreamingMarkdown()}streamingText="";streamingEl=null}renderToolCall(JSON.parse(e.data));loadFilesDebounced()});
  eventSource.addEventListener("file",()=>loadFilesDebounced());
  eventSource.addEventListener("prompt",()=>loadPrompts());
  eventSource.addEventListener("execution",(e)=>{const r=JSON.parse(e.data);const el=document.createElement("div");el.className="msg tool_call";el.textContent=r.error?`Error: ${r.error}`:r.result!=null?`Result: ${JSON.stringify(r.result,null,2)}`:'\u2713 Done';$("chat").appendChild(el);$("chat").scrollTop=$("chat").scrollHeight});
  eventSource.addEventListener("error_message",(e)=>{hideThinking();setProcessing(false);const{message}=JSON.parse(e.data);const el=document.createElement("div");el.className="msg error";el.textContent=message||"Something went wrong";$("chat").appendChild(el);$("chat").scrollTop=$("chat").scrollHeight});
  eventSource.addEventListener("presence",(e)=>{const data=JSON.parse(e.data);presenceUsers=data.users||[];renderPresence()});
}

function renderMessage(msg){
  const el=document.createElement("div");el.className=`msg ${msg.role}`;
  if(msg.role==="assistant"){
    el.innerHTML=renderMarkdown(msg.content);
    el.querySelectorAll('pre').forEach(pre=>{
      const btn=document.createElement('button');btn.className='copy-code';btn.textContent='Copy';
      btn.onclick=(e)=>{e.stopPropagation();const code=pre.querySelector('code')?.textContent||pre.textContent;navigator.clipboard.writeText(code).then(()=>{btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy',1500)})};
      pre.style.position='relative';pre.appendChild(btn);
    });
  }else{el.textContent=msg.content}
  const actions=document.createElement("div");actions.className="msg-actions";
  const copyBtn=document.createElement("button");copyBtn.textContent="Copy";copyBtn.title="Copy message";copyBtn.setAttribute("aria-label","Copy message");
  copyBtn.onclick=()=>{const text=msg.role==="assistant"?msg.content:el.textContent;navigator.clipboard.writeText(text).then(()=>{copyBtn.textContent="Copied!";setTimeout(()=>copyBtn.textContent="Copy",1500)})};
  actions.appendChild(copyBtn);el.appendChild(actions);
  if(msg.role==="assistant"&&(msg.tokenInput||msg.tokenOutput)){const m=document.createElement("div");m.style.cssText="font-size:10px;color:var(--muted);margin-top:6px;opacity:.7";m.textContent=`${msg.tokenInput??0} in / ${msg.tokenOutput??0} out`;el.appendChild(m)}
  $("chat").appendChild(el);$("chat").scrollTop=$("chat").scrollHeight
}
function renderToolCall(tc){
  const el=document.createElement("div");el.className="msg tool_call";
  const hasResult=tc.result!=null&&tc.result!=="null"&&JSON.stringify(tc.result)!=="null";
  const resultStr=hasResult?JSON.stringify(tc.result,null,2):"null";
  const truncated=resultStr.length>500;
  const details=document.createElement("details");
  const summary=document.createElement("summary");summary.textContent="Tool call";details.appendChild(summary);
  const pre=document.createElement("pre");pre.style.cssText="margin:6px 0 0;font-size:11px;white-space:pre-wrap;max-height:200px;overflow:auto";pre.textContent=tc.code||"";details.appendChild(pre);
  const resultDiv=document.createElement("div");resultDiv.style.cssText="margin-top:4px;font-size:11px;color:var(--muted)";resultDiv.textContent=hasResult?"Result: "+(truncated?resultStr.slice(0,500)+"...":resultStr):"\u2713 Done";details.appendChild(resultDiv);
  if(truncated){
    const expandBtn=document.createElement("button");expandBtn.className="sm";expandBtn.style.marginTop="4px";expandBtn.textContent="Show full result";
    expandBtn.onclick=()=>{resultDiv.textContent="Result: "+resultStr;expandBtn.remove()};
    details.appendChild(expandBtn);
  }
  el.appendChild(details);
  $("chat").appendChild(el);$("chat").scrollTop=$("chat").scrollHeight
}
function setStatusDot(status){$("session-status-dot").className=`status-dot ${status==="running"?"running":"idle"}`}
function updateTokenSummary(state){
  const ti=state.totalTokenInput??0,to=state.totalTokenOutput??0;
  $("token-summary").textContent=ti||to?`${(ti/1000).toFixed(1)}k in / ${(to/1000).toFixed(1)}k out`:'';
}

// --- Chat actions ---
async function sendMessage(){if(isProcessing)return;const content=$("msg-input").value.trim();if(!content)return;if(!currentSession){const d=await jsonSafe("/session",{});if(!d)return;currentSession=d.id;await selectSession(d.id)}$("msg-input").value="";$("msg-input").style.height='auto';setProcessing(true);showThinking();try{await json(`/session/${currentSession}/message`,{content})}catch(e){hideThinking();const el=document.createElement("div");el.className="msg error";el.textContent=e.message||"Request failed";$("chat").appendChild(el);$("chat").scrollTop=$("chat").scrollHeight}finally{setProcessing(false);hideThinking();loadFilesDebounced()}}
async function sendAsync(){if(isProcessing)return;const content=$("msg-input").value.trim();if(!content)return;if(!currentSession){const d=await jsonSafe("/session",{});if(!d)return;currentSession=d.id;await selectSession(d.id)}$("msg-input").value="";$("msg-input").style.height='auto';setProcessing(true);showThinking();const result=await jsonSafe(`/session/${currentSession}/prompt`,{content});if(!result){setProcessing(false);hideThinking()}}
async function abortPrompt(){if(!currentSession)return;await jsonSafe(`/session/${currentSession}/abort`,{});setProcessing(false);hideThinking()}
async function forkSession(){if(!currentSession)return;const d=await jsonSafe(`/session/${currentSession}/fork`,{});if(!d)return;const{id}=d;currentSession=id;await selectSession(id)}
async function deleteSession(){if(!currentSession)return;const ok=await appConfirm("Delete this session? This can\u2019t be undone.");if(!ok)return;await apiSafe(`/session/${currentSession}`,{method:"DELETE"});currentSession=null;$("chat").innerHTML="";$("session-title-display").textContent="No session";$("session-id-display").textContent="";$("token-summary").textContent="";$("presence-bar").innerHTML="";history.replaceState(null,"",location.pathname);await loadSessions()}

// --- Session rename ---
async function renameSession(){
  if(!currentSession)return;
  const current=$("session-title-display").textContent;
  const newTitle=prompt("Rename session:",current);
  if(!newTitle||newTitle===current)return;
  $("session-title-display").textContent=newTitle;
  try{await json(`/session/${currentSession}`,{title:newTitle},"PATCH")}catch{}
  await loadSessions();
}

// --- Presence (WebSocket) ---
function connectWebSocket(sessionId){
  if(wsConnection){try{wsConnection.close()}catch{}}
  wsConnection=null;presenceUsers=[];typingUsers=[];renderPresence();
  const protocol=location.protocol==="https:"?"wss:":"ws:";
  try{
    wsConnection=new WebSocket(`${protocol}//${location.host}/session/${sessionId}/ws`);
    wsConnection.onmessage=(e)=>{
      try{
        const msg=JSON.parse(e.data);
        if(msg.type==="presence"){presenceUsers=msg.users||[];renderPresence()}
        if(msg.type==="typing"){typingUsers=msg.users||[];renderTypingIndicator()}
      }catch{}
    };
    wsConnection.onclose=()=>{wsConnection=null};
    wsConnection.onerror=()=>{};
  }catch{}
}

function renderPresence(){
  const bar=$("presence-bar");
  if(!presenceUsers.length){bar.innerHTML="";return}
  const colors=["#0a7c66","#2980b9","#8e44ad","#c0392b","#d35400","#27ae60","#e67e22"];
  bar.innerHTML=presenceUsers.map((u,i)=>{
    const initial=(u.displayName||u.email||"?")[0].toUpperCase();
    const color=colors[i%colors.length];
    return `<div class="presence-avatar" style="background:${color}" title="${esc(u.displayName||u.email)}">${esc(initial)}</div>`;
  }).join("");
}

function renderTypingIndicator(){
  const el=$("typing-indicator");
  const names=typingUsers.filter(u=>u.isTyping).map(u=>u.displayName||u.email);
  if(!names.length){el.style.display="none";return}
  el.style.display="block";
  el.textContent=names.length===1?`${names[0]} is typing...`:`${names.join(", ")} are typing...`;
}
