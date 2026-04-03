// dodo-chat.js — Markdown rendering, SSE, streaming, messages, chat actions, presence

function emailColor(e){let h=0;for(let i=0;i<e.length;i++)h=e.charCodeAt(i)+((h<<5)-h);return "hsl("+(h%360)+",55%,42%)"}

// Markdown rendering for assistant messages
let _markedConfigured=false;
function renderMarkdown(text){
  if(typeof marked==="undefined")return esc(text);
  if(!_markedConfigured){marked.setOptions({breaks:true,gfm:true});_markedConfigured=true}
  try{return marked.parse(text)}catch{return esc(text)}
}

// === Dual-mode streaming renderer ===
// Phase 1 (instant): append raw text to a text node — zero latency
// Phase 2 (periodic): full markdown render every ~300ms for rich formatting
let streamingText="";
let _streamRawSpan=null;        // <span> holding the raw unrendered tail
let _streamRenderedIdx=0;       // how many chars of streamingText have been markdown-rendered
let _streamMarkdownTimer=null;  // periodic markdown render
let _streamRafId=null;          // requestAnimationFrame id for scroll
let _streamScrollSentinel=null; // invisible div at bottom for smooth scroll
let _streamLastDelta=0;         // timestamp of last delta for idle detection

function _ensureScrollSentinel(){
  if(_streamScrollSentinel)return;
  _streamScrollSentinel=document.createElement("div");
  _streamScrollSentinel.className="stream-scroll-sentinel";
  _streamScrollSentinel.style.cssText="height:1px;width:1px;flex-shrink:0";
  $("chat").appendChild(_streamScrollSentinel);
}

function _smoothScrollToBottom(){
  if(_streamRafId)return; // already queued
  _streamRafId=requestAnimationFrame(()=>{
    _streamRafId=null;
    if(_streamScrollSentinel){
      _streamScrollSentinel.scrollIntoView({behavior:"smooth",block:"end"});
    }else{
      const chat=$("chat");
      chat.scrollTo({top:chat.scrollHeight,behavior:"smooth"});
    }
  });
}

function _appendRawDelta(delta){
  if(!streamingEl)return;
  if(!_streamRawSpan){
    _streamRawSpan=document.createElement("span");
    _streamRawSpan.className="stream-raw-tail";
    streamingEl.appendChild(_streamRawSpan);
  }
  _streamRawSpan.textContent+=delta;
}

function _doMarkdownRender(){
  if(!streamingEl||!streamingText)return;
  // Replace entire content with rendered markdown
  const rendered=renderMarkdown(streamingText);
  // Preserve the streaming class/cursor
  streamingEl.innerHTML=rendered;
  streamingEl.querySelectorAll('pre').forEach(pre=>{pre.style.position='relative'});
  _streamRenderedIdx=streamingText.length;
  // Re-create raw span for any future deltas
  _streamRawSpan=document.createElement("span");
  _streamRawSpan.className="stream-raw-tail";
  streamingEl.appendChild(_streamRawSpan);
}

function _scheduleMarkdownRender(){
  if(_streamMarkdownTimer)return;
  _streamMarkdownTimer=setTimeout(()=>{
    _streamMarkdownTimer=null;
    _doMarkdownRender();
    _smoothScrollToBottom();
  },300);
}

function _streamIdleCheck(){
  // If no delta for 150ms, do a markdown render (catches pauses mid-stream)
  if(!streamingEl||!streamingText)return;
  if(Date.now()-_streamLastDelta>150&&_streamRenderedIdx<streamingText.length){
    if(_streamMarkdownTimer){clearTimeout(_streamMarkdownTimer);_streamMarkdownTimer=null}
    _doMarkdownRender();
    _smoothScrollToBottom();
  }
}

function _cleanupStreaming(){
  if(_streamMarkdownTimer){clearTimeout(_streamMarkdownTimer);_streamMarkdownTimer=null}
  if(_streamIdleTimer){clearTimeout(_streamIdleTimer);_streamIdleTimer=null}
  if(_streamRafId){cancelAnimationFrame(_streamRafId);_streamRafId=null}
  if(_streamScrollSentinel){_streamScrollSentinel.remove();_streamScrollSentinel=null}
  _streamRawSpan=null;
  _streamRenderedIdx=0;
  _streamLastDelta=0;
  streamingText="";
}

// --- SSE ---
let _streamIdleTimer=null;
function connectSSE(id){
  if(eventSource)eventSource.close();eventSource=new EventSource(`/session/${id}/events`);
  eventSource.onopen=()=>{$("sse-banner").classList.remove("visible");checkVersionOnReconnect()};
  eventSource.onerror=()=>{if(eventSource.readyState===EventSource.CLOSED){$("sse-banner").classList.add("visible")}else if(eventSource.readyState===EventSource.CONNECTING){$("sse-banner").classList.add("visible")}};

  eventSource.addEventListener("text_delta",(e)=>{
    resetSseActivityTimer();hideThinking();
    const{delta}=JSON.parse(e.data);
    if(!streamingEl){
      _ensureScrollSentinel();
      streamingEl=document.createElement("div");
      streamingEl.className="msg assistant streaming";
      streamingText="";_streamRenderedIdx=0;_streamRawSpan=null;
      $("chat").insertBefore(streamingEl,_streamScrollSentinel);
    }
    streamingText+=delta;
    _streamLastDelta=Date.now();
    // Phase 1: instant raw text append
    _appendRawDelta(delta);
    _smoothScrollToBottom();
    // Phase 2: schedule periodic markdown render
    _scheduleMarkdownRender();
    // Idle check: render markdown if stream pauses
    if(_streamIdleTimer)clearTimeout(_streamIdleTimer);
    _streamIdleTimer=setTimeout(_streamIdleCheck,200);
  });

  eventSource.addEventListener("message",(e)=>{
    resetSseActivityTimer();hideThinking();
    const msg=JSON.parse(e.data);
    if(_streamIdleTimer){clearTimeout(_streamIdleTimer);_streamIdleTimer=null}
    if(streamingEl){
      // Final render: full markdown with copy buttons
      streamingEl.classList.remove("streaming");
      streamingEl.innerHTML=renderMarkdown(msg.content);
      streamingEl.querySelectorAll('pre').forEach(pre=>{
        const btn=document.createElement('button');btn.className='copy-code';btn.textContent='Copy';
        btn.onclick=(ev)=>{ev.stopPropagation();const code=pre.querySelector('code')?.textContent||pre.textContent;navigator.clipboard.writeText(code).then(()=>{btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy',1500)})};
        pre.style.position='relative';pre.appendChild(btn);
      });
      const actions=document.createElement("div");actions.className="msg-actions";
      const copyBtn=document.createElement("button");copyBtn.textContent="Copy";copyBtn.title="Copy message";copyBtn.setAttribute("aria-label","Copy message");
      copyBtn.onclick=()=>{navigator.clipboard.writeText(msg.content).then(()=>{copyBtn.textContent="Copied!";setTimeout(()=>copyBtn.textContent="Copy",1500)})};
      actions.appendChild(copyBtn);streamingEl.appendChild(actions);
      if(msg.tokenInput||msg.tokenOutput){const m=document.createElement("div");m.style.cssText="font-size:10px;color:var(--muted);margin-top:6px;opacity:.7";m.textContent=`${msg.tokenInput??0} in / ${msg.tokenOutput??0} out`;streamingEl.appendChild(m)}
      _cleanupStreaming();streamingEl=null;
    }else{renderMessage(msg)}
    _smoothScrollToBottom();
    loadFilesDebounced();apiSafe(`/session/${id}`).then(s=>{if(s)updateTokenSummary(s)});
  });

  eventSource.addEventListener("state",(e)=>{
    resetSseActivityTimer();const s=JSON.parse(e.data);setStatusDot(s.status);updateTokenSummary(s);
    if(s.status!=="running"){
      setProcessing(false);hideThinking();
      if(streamingEl)streamingEl.classList.remove("streaming");
      _cleanupStreaming();streamingEl=null;refreshGit();
    }
  });

  eventSource.addEventListener("tool_call",(e)=>{
    resetSseActivityTimer();hideThinking();
    if(streamingEl){
      // Flush pending markdown before tool call
      if(streamingText&&_streamRenderedIdx<streamingText.length)_doMarkdownRender();
      streamingEl.classList.remove("streaming");
      _cleanupStreaming();streamingEl=null;
    }
    renderToolCall(JSON.parse(e.data));loadFilesDebounced();
  });

  eventSource.addEventListener("file",()=>loadFilesDebounced());
  eventSource.addEventListener("prompt",()=>refreshGit());
  eventSource.addEventListener("execution",(e)=>{const r=JSON.parse(e.data);const el=document.createElement("div");el.className="msg tool_call";el.textContent=r.error?`Error: ${r.error}`:r.result!=null?`Result: ${JSON.stringify(r.result,null,2)}`:'\u2713 Done';$("chat").appendChild(el);_smoothScrollToBottom()});
  eventSource.addEventListener("error_message",(e)=>{hideThinking();setProcessing(false);const{message}=JSON.parse(e.data);const el=document.createElement("div");el.className="msg error";el.textContent=message||"Something went wrong";$("chat").appendChild(el);_smoothScrollToBottom()});
  eventSource.addEventListener("presence",(e)=>{const data=JSON.parse(e.data);presenceUsers=data.users||[];renderPresence()});

  eventSource.addEventListener("queue_update",(e)=>{
    const{queue}=JSON.parse(e.data);
    // Remove any queued bubbles that are no longer in the queue
    document.querySelectorAll('.msg.queued').forEach(el=>{
      const qid=el.dataset.queueId;
      if(qid&&!queue.find(q=>q.id===qid))el.remove();
    });
    // Update positions on remaining
    queue.forEach(q=>{
      const el=document.querySelector(`.msg.queued[data-queue-id="${q.id}"]`);
      if(el){const pos=el.querySelector('.queue-position');if(pos)pos.textContent=`#${q.position} in queue`}
    });
  });
}

function showQueuedMessage(content,queueId,position){
  const el=document.createElement("div");el.className="msg user queued";el.dataset.queueId=queueId;
  el.innerHTML=`<div style="opacity:.5">${esc(content)}</div><div style="display:flex;align-items:center;gap:6px;margin-top:4px"><span class="queue-position" style="font-size:10px;color:var(--muted)">#${position} in queue</span><button class="sm" onclick="cancelQueued('${esc(queueId)}',this)" style="font-size:10px;padding:1px 6px">Cancel</button></div>`;
  $("chat").appendChild(el);_smoothScrollToBottom();
}

async function cancelQueued(queueId,btn){
  if(!currentSession)return;
  await apiSafe(`/session/${currentSession}/prompt-queue/${encodeURIComponent(queueId)}`,{method:"DELETE"});
  const el=btn.closest('.msg.queued');if(el)el.remove();
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
  }else{
    const authorEmail=msg.authorEmail||msg.author||msg.email||null;
    const label=document.createElement("div");
    label.style.cssText="font-size:10px;margin-bottom:2px;";
    if(authorEmail&&window._userEmail&&authorEmail!==window._userEmail){
      label.style.color=emailColor(authorEmail);label.textContent=authorEmail;
    }else{label.style.color=emailColor(authorEmail||"you");label.textContent="You"}
    el.appendChild(label);
    el.appendChild(document.createTextNode(msg.content));
  }
  const actions=document.createElement("div");actions.className="msg-actions";
  const copyBtn=document.createElement("button");copyBtn.textContent="Copy";copyBtn.title="Copy message";copyBtn.setAttribute("aria-label","Copy message");
  copyBtn.onclick=()=>{navigator.clipboard.writeText(msg.content).then(()=>{copyBtn.textContent="Copied!";setTimeout(()=>copyBtn.textContent="Copy",1500)})};
  actions.appendChild(copyBtn);el.appendChild(actions);
  if(msg.role==="assistant"&&(msg.tokenInput||msg.tokenOutput)){const m=document.createElement("div");m.style.cssText="font-size:10px;color:var(--muted);margin-top:6px;opacity:.7";m.textContent=`${msg.tokenInput??0} in / ${msg.tokenOutput??0} out`;el.appendChild(m)}
  $("chat").appendChild(el);_smoothScrollToBottom()
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
  $("chat").appendChild(el);_smoothScrollToBottom()
}
function setStatusDot(status){$("session-status-dot").className=`status-dot ${status==="running"?"running":"idle"}`}
function updateTokenSummary(state){
  const ti=state.totalTokenInput??0,to=state.totalTokenOutput??0;
  const contextStr=ti?` · Context: ${Math.round(ti/1000)}k`:'';
  $("token-summary").textContent=ti||to?`${(ti/1000).toFixed(1)}k in / ${(to/1000).toFixed(1)}k out${contextStr}`:'';
}

// --- Chat actions ---
async function sendMessage(){
  const content=$("msg-input").value.trim();if(!content)return;
  if(!currentSession){const d=await jsonSafe("/session",{});if(!d)return;currentSession=d.id;await selectSession(d.id)}
  $("msg-input").value="";$("msg-input").style.height='auto';
  if(isProcessing){
    // Queue the prompt — show as pending bubble
    const result=await jsonSafe(`/session/${currentSession}/prompt`,{content});
    if(result&&result.status==="queued"){
      showQueuedMessage(content,result.promptId,result.position);
    }
    return;
  }
  setProcessing(true);showThinking();
  const result=await jsonSafe(`/session/${currentSession}/prompt`,{content});
  if(!result){setProcessing(false);hideThinking()}
}
async function abortPrompt(){if(!currentSession)return;await jsonSafe(`/session/${currentSession}/abort`,{});setProcessing(false);hideThinking()}
async function forkSession(){if(!currentSession)return;const d=await jsonSafe(`/session/${currentSession}/fork`,{});if(!d)return;const{id}=d;currentSession=id;await selectSession(id)}
async function deleteSession(){if(!currentSession)return;const ok=await appConfirm("Delete this session? This can\u2019t be undone.");if(!ok)return;await apiSafe(`/session/${currentSession}`,{method:"DELETE"});currentSession=null;$("chat").innerHTML="";$("session-title-display").textContent="No session";$("session-id-display").textContent="";$("token-summary").textContent="";$("presence-bar").innerHTML="";history.replaceState(null,"",location.pathname);await loadSessions();if(window.innerWidth<=900)switchTab('chat')}

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
