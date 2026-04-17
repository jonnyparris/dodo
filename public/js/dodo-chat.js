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
    // Guard: empty assistant response with no preceding stream = silent LLM failure
    if(msg.role==="assistant"&&!msg.content&&!streamingEl){
      setProcessing(false);
      const el=document.createElement("div");el.className="msg error";
      el.textContent="Empty response from model — the request may have failed silently. Try again or switch models.";
      $("chat").appendChild(el);_smoothScrollToBottom();
      loadFilesDebounced();apiSafe(`/session/${id}`).then(s=>{if(s)updateTokenSummary(s)});
      return;
    }
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

  // tool_result fires when a tool finishes and may carry image attachments
  // (e.g. browser_execute screenshots). Updates the in-flight tool_call
  // bubble in place with the output + any images.
  eventSource.addEventListener("tool_result",(e)=>{
    resetSseActivityTimer();
    try{updateToolCallResult(JSON.parse(e.data))}catch{}
    loadFilesDebounced();
  });

  // tool_attachments fires as soon as a tool extracts and uploads images to
  // R2, before the tool output itself arrives on tool_result. We attach the
  // images to the tool bubble early for snappy UX.
  eventSource.addEventListener("tool_attachments",(e)=>{
    resetSseActivityTimer();
    try{
      const data=JSON.parse(e.data);
      const entry=_toolCallBubbles.get(data.toolCallId);
      if(entry)_appendAttachmentImages(entry.el,data.attachments);
    }catch{}
  });

  // message_attachments fires when the assistant generates images (Gemma,
  // Gemini imagen, etc.) — the text streams first, then the finalised image
  // references arrive. Attach them to the already-rendered bubble.
  eventSource.addEventListener("message_attachments",(e)=>{
    resetSseActivityTimer();
    try{
      const data=JSON.parse(e.data);
      attachImagesToMessage(data.messageId,data.attachments);
    }catch{}
  });

  eventSource.addEventListener("file",()=>loadFilesDebounced());
  eventSource.addEventListener("prompt",(e)=>{
    refreshGit();
    // Check for failed prompts and surface errors the error_message event may have missed
    try{
      const prompts=JSON.parse(e.data);
      if(Array.isArray(prompts)){
        // Only check the most recent prompt (first in descending order)
        const latest=prompts[0];
        if(latest&&latest.status==="failed"&&latest.error){
          // Only show if there isn't already an error bubble with this text
          const existing=[...$("chat").querySelectorAll(".msg.error")].some(el=>el.textContent===latest.error);
          if(!existing){
            hideThinking();setProcessing(false);
            const el=document.createElement("div");el.className="msg error";
            el.textContent=latest.error;
            $("chat").appendChild(el);_smoothScrollToBottom();
          }
        }
      }
    }catch{}
  });
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
  el.innerHTML=`<div style="opacity:.6">${esc(content)}</div><div style="display:flex;align-items:center;gap:6px;margin-top:4px"><span class="queue-position" style="font-size:10px;color:var(--text);opacity:.7">#${position} in queue</span><button class="sm" onclick="cancelQueued('${esc(queueId)}',this)" style="font-size:10px;padding:1px 6px">Cancel</button></div>`;
  $("chat").appendChild(el);_smoothScrollToBottom();
}

async function cancelQueued(queueId,btn){
  if(!currentSession)return;
  await apiSafe(`/session/${currentSession}/prompt-queue/${encodeURIComponent(queueId)}`,{method:"DELETE"});
  const el=btn.closest('.msg.queued');if(el)el.remove();
}

// Render an image attachment list into a container element. Used both on
// message bubbles (user uploads, assistant-generated images, tool screenshots)
// and on inline tool_call bubbles. `url` may be a data URL (inline fallback)
// or a served path like /session/:id/attachment/... — we just trust the
// server-provided URL and only block the one footgun case (inline data URLs
// that aren't images).
function _appendAttachmentImages(container, attachments){
  if(!attachments||!attachments.length)return;
  const wrap=document.createElement("div");wrap.className="msg-attachment";
  attachments.forEach((a,i)=>{
    if(!a||typeof a.url!=="string")return;
    if(a.url.startsWith("data:")&&!a.url.startsWith("data:image/"))return;
    const img=document.createElement("img");
    img.src=a.url;
    img.alt=`Attachment ${i+1} of ${attachments.length}`;
    img.loading="lazy";
    img.onclick=()=>window.open(a.url,"_blank","noopener,noreferrer");
    img.style.cursor="zoom-in";
    wrap.appendChild(img);
  });
  if(wrap.childElementCount>0)container.appendChild(wrap);
}

function renderMessage(msg){
  const el=document.createElement("div");el.className=`msg ${msg.role}`;
  if(msg.id)el.dataset.msgId=msg.id;
  if(msg.role==="assistant"){
    el.innerHTML=renderMarkdown(msg.content);
    el.querySelectorAll('pre').forEach(pre=>{
      const btn=document.createElement('button');btn.className='copy-code';btn.textContent='Copy';
      btn.onclick=(e)=>{e.stopPropagation();const code=pre.querySelector('code')?.textContent||pre.textContent;navigator.clipboard.writeText(code).then(()=>{btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy',1500)})};
      pre.style.position='relative';pre.appendChild(btn);
    });
    // Assistant bubbles can also carry attachments — model-generated images
    // from Gemini/Gemma, or screenshots surfaced via the assistant's final
    // tool-result summary.
    _appendAttachmentImages(el,msg.attachments);
  }else{
    const authorEmail=msg.authorEmail||msg.author||msg.email||null;
    const label=document.createElement("div");
    label.style.cssText="font-size:10px;margin-bottom:2px;";
    if(authorEmail&&window._userEmail&&authorEmail!==window._userEmail){
      label.style.color=emailColor(authorEmail);label.textContent=authorEmail;
    }else{label.style.color="rgba(255,255,255,.75)";label.textContent="You"}
    el.appendChild(label);
    el.appendChild(document.createTextNode(msg.content));
    _appendAttachmentImages(el,msg.attachments);
  }
  const actions=document.createElement("div");actions.className="msg-actions";
  const copyBtn=document.createElement("button");copyBtn.textContent="Copy";copyBtn.title="Copy message";copyBtn.setAttribute("aria-label","Copy message");
  copyBtn.onclick=()=>{navigator.clipboard.writeText(msg.content).then(()=>{copyBtn.textContent="Copied!";setTimeout(()=>copyBtn.textContent="Copy",1500)})};
  actions.appendChild(copyBtn);el.appendChild(actions);
  if(msg.role==="assistant"&&(msg.tokenInput||msg.tokenOutput)){const m=document.createElement("div");m.style.cssText="font-size:10px;color:var(--muted);margin-top:6px;opacity:.7";m.textContent=`${msg.tokenInput??0} in / ${msg.tokenOutput??0} out`;el.appendChild(m)}
  $("chat").appendChild(el);_smoothScrollToBottom()
}
// Track in-flight tool calls so tool_result events can enrich the same bubble
// rather than creating a new one. Keyed by toolCallId.
const _toolCallBubbles=new Map();

function renderToolCall(tc){
  // tc may come from the legacy single-event form (code+result) or the new
  // tool_call event (toolCallId + toolName + input). We render the "call has
  // started" state; tool_result updates the same bubble when output arrives.
  const el=document.createElement("div");el.className="msg tool_call";
  if(tc.toolCallId)el.dataset.toolCallId=tc.toolCallId;
  const details=document.createElement("details");details.open=false;
  const summary=document.createElement("summary");
  const toolName=tc.toolName||tc.name||"tool";
  summary.textContent=`${toolName} \u2026`;
  details.appendChild(summary);
  // Show the tool input (args) if present — for code-mode tools this is the
  // actual JS that ran. Legacy event shape put this in `code`.
  const inputText=tc.code||(tc.input?JSON.stringify(tc.input,null,2):"");
  if(inputText){
    const pre=document.createElement("pre");
    pre.style.cssText="margin:6px 0 0;font-size:11px;white-space:pre-wrap;max-height:200px;overflow:auto";
    pre.textContent=inputText;
    details.appendChild(pre);
  }
  // Placeholder for the result — filled in by updateToolCallResult.
  const resultDiv=document.createElement("div");
  resultDiv.className="tool-result-body";
  resultDiv.style.cssText="margin-top:4px;font-size:11px;color:var(--muted)";
  resultDiv.textContent="Running\u2026";
  details.appendChild(resultDiv);
  el.appendChild(details);
  // Legacy callers pass `result` directly on the call event — render once.
  if(tc.result!=null){
    _fillToolResult(el,summary,resultDiv,{output:tc.result,attachments:tc.attachments});
  }else if(tc.toolCallId){
    _toolCallBubbles.set(tc.toolCallId,{el,summary,resultDiv,toolName});
  }
  $("chat").appendChild(el);_smoothScrollToBottom()
}

function updateToolCallResult(tr){
  if(!tr||!tr.toolCallId)return;
  const entry=_toolCallBubbles.get(tr.toolCallId);
  if(!entry){
    // Result arrived with no matching call bubble — render it fresh so the
    // image/output is still visible.
    renderToolCall({toolCallId:tr.toolCallId,toolName:tr.toolName,result:tr.output,attachments:tr.attachments});
    return;
  }
  _fillToolResult(entry.el,entry.summary,entry.resultDiv,tr);
  _toolCallBubbles.delete(tr.toolCallId);
}

function _fillToolResult(el,summary,resultDiv,tr){
  const output=tr.output;
  const outputStr=typeof output==="string"?output:JSON.stringify(output,null,2);
  const hasResult=outputStr!=null&&outputStr!=="null"&&outputStr!=="";
  const truncated=hasResult&&outputStr.length>500;
  summary.textContent=`${summary.textContent.replace(/\s*\u2026$/,"")} \u2713`;
  resultDiv.textContent=hasResult?"Result: "+(truncated?outputStr.slice(0,500)+"...":outputStr):"\u2713 Done";
  if(truncated){
    const expandBtn=document.createElement("button");
    expandBtn.className="sm";expandBtn.style.marginTop="4px";expandBtn.textContent="Show full result";
    expandBtn.onclick=()=>{resultDiv.textContent="Result: "+outputStr;expandBtn.remove()};
    resultDiv.parentElement.appendChild(expandBtn);
  }
  // Render any image attachments the tool produced (screenshots).
  _appendAttachmentImages(el,tr.attachments);
}

// Attach images to an already-rendered message bubble by id. Used when the
// stream emits `message_attachments` (assistant-generated images) after the
// message bubble has already been painted from the text stream.
function attachImagesToMessage(messageId,attachments){
  if(!messageId||!attachments||!attachments.length)return;
  const el=$("chat").querySelector(`.msg[data-msg-id="${CSS.escape(messageId)}"]`);
  if(!el)return;
  _appendAttachmentImages(el,attachments);
}
function setStatusDot(status){$("session-status-dot").className=`status-dot ${status==="running"?"running":"idle"}`}
function updateTokenSummary(state){
  const ti=state.totalTokenInput??0,to=state.totalTokenOutput??0;
  const pct=state.contextUsagePercent??0;
  const budget=state.contextBudget??0;
  const el=$("token-summary");
  if(!ti&&!to){el.textContent='';el.title='';return}
  // Color code by context usage
  let color='var(--text-subtle)';
  if(pct>80)color='#e74c3c';
  else if(pct>50)color='#e67e22';
  el.style.color=color;
  const budgetStr=budget?`${Math.round(budget/1000)}k`:'?';
  el.textContent=pct>0?`Context: ${pct}% of ${budgetStr} · ${(ti/1000).toFixed(1)}k in / ${(to/1000).toFixed(1)}k out`:`${(ti/1000).toFixed(1)}k in / ${(to/1000).toFixed(1)}k out`;
  el.title=`Context window: ${state.contextWindow??0} tokens\nBudget (80%): ${budget} tokens\nUsage: ~${pct}%\nModel: ${state.model??'unknown'}`;
  // Show/hide context warning banner
  const banner=$("context-warning");
  if(banner){
    if(pct>80){banner.style.display="block";banner.textContent=`Context is ${pct}% full. Consider starting a new session for a fresh topic.`}
    else{banner.style.display="none"}
  }
}

// --- Chat actions ---
async function sendMessage(){
  const content=$("msg-input").value.trim();
  const images=getPendingImages();
  if(!content&&!images)return;
  if(!content)return toast("Add a text message with your images","warning");
  // Block sending images while a prompt is running — the queued-prompt path
  // can't carry attachments end-to-end, and silently dropping them is worse
  // than asking the user to wait.
  if(isProcessing&&images)return toast("Wait for the current response before sending images","warning");
  sendTypingStop();
  if(!currentSession){const d=await jsonSafe("/session",{});if(!d)return;currentSession=d.id;await selectSession(d.id)}
  $("msg-input").value="";$("msg-input").style.height='auto';clearPendingImages();
  const payload=images?{content,images}:{content};
  if(isProcessing){
    // Queue text-only prompts. Image-carrying prompts are blocked above.
    const result=await jsonSafe(`/session/${currentSession}/prompt`,{content});
    if(result&&result.status==="queued"){
      showQueuedMessage(content,result.promptId,result.position);
    }
    return;
  }
  setProcessing(true);showThinking();
  const result=await jsonSafe(`/session/${currentSession}/prompt`,payload);
  if(!result){setProcessing(false);hideThinking()}
}
async function abortPrompt(){if(!currentSession)return;await jsonSafe(`/session/${currentSession}/abort`,{});setProcessing(false);hideThinking()}
async function forkSession(){if(!currentSession)return;const d=await jsonSafe(`/session/${currentSession}/fork`,{});if(!d)return;const{id}=d;currentSession=id;await selectSession(id)}
async function deleteSession(){if(!currentSession)return;const ok=await appConfirm("Delete this session? This can\u2019t be undone.");if(!ok)return;await apiSafe(`/session/${currentSession}`,{method:"DELETE"});currentSession=null;clearPendingImages();$("chat").innerHTML="";$("session-title-display").textContent="No session";$("session-id-display").textContent="";$("token-summary").textContent="";$("token-summary").style.color="";const cw=$("context-warning");if(cw)cw.style.display="none";$("presence-bar").innerHTML="";history.replaceState(null,"",location.pathname);await loadSessions();if(window.innerWidth<=900)switchTab('chat')}

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
  const me=window._userEmail;
  const names=typingUsers.filter(u=>u.isTyping&&u.email!==me).map(u=>u.displayName||u.email);
  if(!names.length){el.style.display="none";return}
  el.style.display="block";
  el.textContent=names.length===1?`${names[0]} is typing...`:`${names.join(", ")} are typing...`;
}

// --- Typing notifications (outbound) ---
let _typingSent=false,_typingTimer=null;
function sendTypingStart(){
  if(!wsConnection||wsConnection.readyState!==WebSocket.OPEN)return;
  if(!_typingSent){
    wsConnection.send(JSON.stringify({type:"typing",isTyping:true}));
    _typingSent=true;
  }
  if(_typingTimer)clearTimeout(_typingTimer);
  _typingTimer=setTimeout(()=>{sendTypingStop()},3000);
}
function sendTypingStop(){
  if(_typingTimer){clearTimeout(_typingTimer);_typingTimer=null}
  if(!_typingSent)return;
  _typingSent=false;
  if(wsConnection&&wsConnection.readyState===WebSocket.OPEN){
    wsConnection.send(JSON.stringify({type:"typing",isTyping:false}));
  }
}

// --- Image attachments ---
// Limits kept in sync with `imageAttachmentSchema` in src/coding-agent.ts.
// Backend caps base64 length at 4_000_000 chars (~3MB decoded per image, 5 per message);
// 3MB raw here is a conservative frontend bound that stays under the backend limit
// after base64 encoding (3MB * 4/3 ≈ 4MB).
const _pendingImages=[];
const MAX_IMAGE_SIZE=3*1024*1024; // 3MB raw — pairs with ~4MB base64 on the backend
const MAX_IMAGES=5;
const ALLOWED_IMAGE_TYPES=new Set(["image/png","image/jpeg","image/gif","image/webp"]);

function handleImagePaste(event){
  const items=event.clipboardData?.items;
  if(!items)return;
  for(const item of items){
    if(ALLOWED_IMAGE_TYPES.has(item.type)){
      event.preventDefault();
      const file=item.getAsFile();
      if(file)addImageFile(file);
      return;
    }
  }
}

function handleFileSelect(input){
  for(const file of input.files){
    if(ALLOWED_IMAGE_TYPES.has(file.type))addImageFile(file);
    else toast(`${file.type} not supported. Use PNG, JPEG, GIF, or WebP.`,"warning");
  }
  input.value="";
}

function addImageFile(file){
  if(_pendingImages.length>=MAX_IMAGES)return toast(`Maximum ${MAX_IMAGES} images per message`,"warning");
  if(file.size>MAX_IMAGE_SIZE)return toast("Image too large (max 3MB)","warning");
  const reader=new FileReader();
  reader.onload=()=>{
    const dataUrl=reader.result;
    const base64=dataUrl.split(",")[1];
    const mediaType=file.type;
    _pendingImages.push({data:base64,mediaType,dataUrl,name:file.name||""});
    renderImagePreviews();
  };
  reader.onerror=()=>toast("Failed to read image file","warning");
  reader.readAsDataURL(file);
}

function removeImage(idx){
  _pendingImages.splice(idx,1);
  renderImagePreviews();
}

function renderImagePreviews(){
  const bar=$("image-preview-bar");
  bar.replaceChildren();
  const total=_pendingImages.length;
  _pendingImages.forEach((img,i)=>{
    const wrap=document.createElement("div");wrap.className="image-preview-item";
    const imgEl=document.createElement("img");imgEl.src=img.dataUrl;
    imgEl.alt=img.name?`Attachment: ${img.name}`:`Attachment ${i+1} of ${total}`;
    const btn=document.createElement("button");btn.className="remove-btn";btn.textContent="\u00d7";
    btn.setAttribute("aria-label",img.name?`Remove ${img.name}`:`Remove attachment ${i+1}`);
    btn.onclick=()=>removeImage(i);
    wrap.appendChild(imgEl);wrap.appendChild(btn);bar.appendChild(wrap);
  });
}

function getPendingImages(){
  if(!_pendingImages.length)return undefined;
  return _pendingImages.map(({data,mediaType})=>({data,mediaType}));
}

function clearPendingImages(){
  _pendingImages.length=0;
  renderImagePreviews();
}
