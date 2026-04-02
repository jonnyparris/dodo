// dodo-core.js — Shared state, utilities, theme, panels, resize, toast, confirm

// --- Error monitoring ---
(function(){
  var errQueue = [];
  var lastSent = 0;
  var MIN_INTERVAL = 2000;

  function reportError(msg, source, lineno, colno, stack) {
    var now = Date.now();
    if (now - lastSent < MIN_INTERVAL) {
      errQueue.push({ msg: msg, source: source, lineno: lineno, colno: colno, stack: stack });
      return;
    }
    lastSent = now;
    navigator.sendBeacon("/api/errors", JSON.stringify({
      message: msg,
      source: source,
      lineno: lineno,
      colno: colno,
      stack: stack,
      userAgent: navigator.userAgent,
      url: location.href,
    }));
  }

  window.onerror = function(msg, source, lineno, colno, error) {
    reportError(msg, source, lineno, colno, error && error.stack ? error.stack : undefined);
  };

  window.onunhandledrejection = function(event) {
    var reason = event.reason;
    var msg = reason instanceof Error ? reason.message : String(reason);
    var stack = reason instanceof Error ? reason.stack : undefined;
    reportError("Unhandled rejection: " + msg, "", 0, 0, stack);
  };

  setInterval(function(){
    if (!errQueue.length) return;
    var batch = errQueue.splice(0, 5);
    batch.forEach(function(e){
      reportError(e.msg, e.source, e.lineno, e.colno, e.stack);
    });
  }, 5000);
})();

// --- Shared state ---
let currentSession=null,eventSource=null,isProcessing=false,streamingEl=null,expandedDirs=new Set(),activeTab='chat';
let wsConnection=null,presenceUsers=[],typingUsers=[];
let allSessions=[];

// --- DOM helpers ---
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

// === Theme management ===
function getTheme(){
  const stored=localStorage.getItem('dodo-theme');
  if(stored)return stored;
  return window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-mode',theme);
  const icon=$('theme-icon');
  if(icon){icon.className=theme==='dark'?'ph ph-sun':'ph ph-moon'}
  updateFavicon();
}
// === Favicon blink during processing ===
let _faviconBlinkTimer=null;
let _faviconBlinkOn=true;
const _faviconCursor={
  dark:'<rect x="13" y="24" width="6" height="1" rx=".5" fill="#7B2CF5"/>',
  light:'<rect x="13" y="24" width="6" height="1" rx=".5" fill="#6B21A8"/>'
};
function _buildFaviconDataUri(theme,showCursor){
  const bg=theme==='dark'?'#0D1117':'#f0f0f0';
  const br=theme==='dark'?'#7B2CF5':'#6B21A8';
  const eye=bg;
  const cursor=showCursor?_faviconCursor[theme]:'';
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><rect width="32" height="32" rx="6" fill="${bg}"/><path d="M4 16 L10 10 L10 12 L6.5 16 L10 20 L10 22 L4 16Z" fill="${br}"/><path d="M28 16 L22 10 L22 12 L25.5 16 L22 20 L22 22 L28 16Z" fill="${br}"/><ellipse cx="16" cy="17" rx="5.5" ry="4.2" fill="#F5A623"/><circle cx="19" cy="13" r="2.8" fill="#F5A623"/><circle cx="20" cy="12.3" r="0.7" fill="${eye}"/><path d="M21.2 13.5 Q23.5 13 23.2 14.2 Q23 15 21.5 14.5Z" fill="${br}"/><path d="M12.5 16 Q14.5 14.5 15.8 16 Q16.8 17.3 14.5 17.8 Q12.5 18 12.5 16Z" fill="#D4891A" opacity="0.9"/><path d="M10.5 17 L8.8 15.5 L8.5 16.5 L10 17.5 L8.5 19 L8.8 19.5 L10.5 18Z" fill="${br}" opacity="0.7"/>${cursor}</svg>`;
  return 'data:image/svg+xml,'+encodeURIComponent(svg);
}
function _startFaviconBlink(){
  if(_faviconBlinkTimer)return;
  const fav=$('favicon');
  if(!fav)return;
  _faviconBlinkOn=true;
  const theme=getTheme();
  fav.href=_buildFaviconDataUri(theme,true);
  _faviconBlinkTimer=setInterval(()=>{
    _faviconBlinkOn=!_faviconBlinkOn;
    fav.href=_buildFaviconDataUri(getTheme(),_faviconBlinkOn);
  },600);
}
function _stopFaviconBlink(){
  if(_faviconBlinkTimer){clearInterval(_faviconBlinkTimer);_faviconBlinkTimer=null}
}
function updateFavicon(){
  const theme=getTheme();
  const logoSrc=theme==='dark'?'/favicon-dark.svg':'/favicon-light.svg';
  document.querySelectorAll('.dodo-logo-img').forEach(img=>{img.src=logoSrc});
  if(isProcessing){_startFaviconBlink()}else{_stopFaviconBlink();const fav=$('favicon');if(fav)fav.href=logoSrc}
}
function toggleTheme(){
  const current=getTheme();
  const next=current==='dark'?'light':'dark';
  localStorage.setItem('dodo-theme',next);
  applyTheme(next);
}
applyTheme(getTheme());

// === Multi-line input handling ===
function handleInputKeydown(event){
  if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage()}
}
function autoResizeInput(el){
  el.style.height='auto';
  el.style.height=Math.min(el.scrollHeight,160)+'px';
}

// === API helpers ===
const api=async(path,opts)=>{const r=await fetch(path,opts);const data=r.headers.get("content-type")?.includes("json")?await r.json():await r.text();if(!r.ok){const msg=typeof data==="object"?data.error||"Request failed":data;const e=new Error(msg);e.status=r.status;e.data=data;throw e}return data};
const json=(path,body,method="POST")=>api(path,{method,headers:{"content-type":"application/json"},body:JSON.stringify(body)});
const apiSafe=async(path,opts)=>{try{return await api(path,opts)}catch{return null}};
const jsonSafe=async(path,body,method="POST")=>{try{return await json(path,body,method)}catch{return null}};

// === Loading skeleton helper ===
function showSkeleton(el,lines=3){
  el.innerHTML=Array.from({length:lines},(_,i)=>{
    const w=Math.floor(Math.random()*40)+60;
    const dur=(1.3+Math.random()*0.4).toFixed(2);
    const delay=(Math.random()*0.5).toFixed(2);
    return `<div class="skeleton-line" style="width:${w}%;--sk-dur:${dur}s;--sk-delay:${delay}s"></div>`;
  }).join('');
}

// === Panel collapse/expand ===
function togglePanel(panel){
  const el=panel==='sidebar'?$('sidebar-panel'):$('right-panel');
  const handle=panel==='sidebar'?$('resize-left'):$('resize-right');
  const btn=panel==='sidebar'?$('toggle-sidebar-btn'):$('toggle-right-btn');
  const collapsed=el.classList.toggle('collapsed');
  if(handle)handle.style.display=collapsed?'none':'';
  if(btn)btn.textContent=panel==='sidebar'?(collapsed?'\u00BB':'\u00AB'):(collapsed?'\u00AB':'\u00BB');
  updateGridColumns();
  localStorage.setItem('dodo-'+panel+'-collapsed',collapsed?'1':'0');
}
function updateGridColumns(){
  if(window.innerWidth<=900)return;
  const app=$('app');
  const sidebarCollapsed=$('sidebar-panel').classList.contains('collapsed');
  const rightCollapsed=$('right-panel').classList.contains('collapsed');
  const sw=sidebarCollapsed?'0px':getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim()||'260px';
  const rw=rightCollapsed?'0px':getComputedStyle(document.documentElement).getPropertyValue('--right-w').trim()||'280px';
  const handleL=sidebarCollapsed?'0px':'5px';
  const handleR=rightCollapsed?'0px':'5px';
  app.style.gridTemplateColumns=`${sw} ${handleL} 1fr ${handleR} ${rw}`;
}
// Restore collapsed state from localStorage
(function restorePanels(){
  if(localStorage.getItem('dodo-sidebar-collapsed')==='1'){
    $('sidebar-panel')?.classList.add('collapsed');
    const h=$('resize-left');if(h)h.style.display='none';
    const b=$('toggle-sidebar-btn');if(b)b.textContent='\u00BB';
  }
  if(localStorage.getItem('dodo-right-collapsed')==='1'){
    $('right-panel')?.classList.add('collapsed');
    const h=$('resize-right');if(h)h.style.display='none';
    const b=$('toggle-right-btn');if(b)b.textContent='\u00AB';
  }
  requestAnimationFrame(()=>updateGridColumns());
})();

// === Resize handles ===
(function initResize(){
  const savedSW=localStorage.getItem('dodo-sidebar-width');
  const savedRW=localStorage.getItem('dodo-right-width');
  if(savedSW)document.documentElement.style.setProperty('--sidebar-w',savedSW);
  if(savedRW)document.documentElement.style.setProperty('--right-w',savedRW);

  function setupHandle(handleId,cssVar,storageKey,direction){
    const handle=$(handleId);
    if(!handle)return;
    let startX,startW;
    handle.addEventListener('mousedown',(e)=>{
      e.preventDefault();
      handle.classList.add('dragging');
      document.body.style.cursor='col-resize';
      document.body.style.userSelect='none';
      startX=e.clientX;
      const currentVal=getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
      startW=parseInt(currentVal)||260;
      function onMove(e2){
        const delta=direction==='left'?(e2.clientX-startX):(startX-e2.clientX);
        const newW=Math.max(180,Math.min(500,startW+delta));
        document.documentElement.style.setProperty(cssVar,newW+'px');
        updateGridColumns();
      }
      function onUp(){
        handle.classList.remove('dragging');
        document.body.style.cursor='';
        document.body.style.userSelect='';
        const finalVal=getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
        localStorage.setItem(storageKey,finalVal);
        document.removeEventListener('mousemove',onMove);
        document.removeEventListener('mouseup',onUp);
      }
      document.addEventListener('mousemove',onMove);
      document.addEventListener('mouseup',onUp);
    });
  }
  setupHandle('resize-left','--sidebar-w','dodo-sidebar-width','left');
  setupHandle('resize-right','--right-w','dodo-right-width','right');
})();

// === Toast notifications ===
const TOAST_ICONS={success:'<i class="ph ph-check-circle"></i>',error:'<i class="ph ph-x-circle"></i>',warning:'<i class="ph ph-warning"></i>',info:'<i class="ph ph-info"></i>',default:''};
function toast(titleOrMsg,type='default',duration=3500){
  const container=$('toast-container');
  const el=document.createElement('div');
  el.className=`toast ${type}`;
  const icon=TOAST_ICONS[type]||'';
  const isObj=typeof titleOrMsg==='object';
  const title=isObj?titleOrMsg.title:titleOrMsg;
  const desc=isObj?titleOrMsg.description:'';
  el.innerHTML=`${icon?`<span class="toast-icon">${icon}</span>`:''}
    <div class="toast-body">${title?`<div class="toast-title">${esc(title)}</div>`:''}${desc?`<div class="toast-desc">${esc(desc)}</div>`:''}</div>
    <button class="toast-close" onclick="this.parentElement.remove()" aria-label="Dismiss">&times;</button>`;
  container.appendChild(el);
  setTimeout(()=>{el.classList.add('fade-out');setTimeout(()=>el.remove(),200)},duration);
}

// --- In-app confirm dialog ---
function appConfirm(message,{confirmText='Delete',cancelText='Cancel',danger=true}={}){
  return new Promise(resolve=>{
    const overlay=document.createElement('div');overlay.className='confirm-overlay';
    overlay.innerHTML=`<div class="confirm-card"><p>${esc(message)}</p><div class="confirm-actions"><button class="ghost" id="confirm-cancel">${esc(cancelText)}</button><button class="${danger?'danger':'primary'}" id="confirm-ok">${esc(confirmText)}</button></div></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#confirm-ok').onclick=()=>{overlay.remove();resolve(true)};
    overlay.querySelector('#confirm-cancel').onclick=()=>{overlay.remove();resolve(false)};
    overlay.addEventListener('click',(e)=>{if(e.target===overlay){overlay.remove();resolve(false)}});
    overlay.querySelector('#confirm-ok').focus();
  });
}

async function showConfirm(message,onConfirm,{confirmText='Confirm',danger=false}={}){
  const ok=await appConfirm(message,{confirmText,danger});
  if(ok&&onConfirm)await onConfirm();
}

// --- Help overlay ---
function showHelp(){$('help-overlay').style.display='flex'}
function hideHelp(){$('help-overlay').style.display='none'}

// --- Processing state ---
let sseActivityTimer=null;
let sseStallWarned=false;
function resetSseActivityTimer(){
  if(sseActivityTimer)clearTimeout(sseActivityTimer);
  sseStallWarned=false;
  if(!isProcessing)return;
  sseActivityTimer=setTimeout(()=>{if(isProcessing&&!sseStallWarned){sseStallWarned=true;toast({title:"No response from server",description:"The request may still be running. Try waiting or abort and retry."},"warning",8000)}},60000);
}
function setProcessing(active){
  isProcessing=active;
  $("send-btn").disabled=active;$("abort-btn").disabled=!active;$("msg-input").disabled=active;
  $("send-btn").innerHTML=active?'<span class="spinner"></span>':'Send';
  updateFavicon();
  if(active){resetSseActivityTimer()}else{if(sseActivityTimer){clearTimeout(sseActivityTimer);sseActivityTimer=null}sseStallWarned=false}
}
function showThinking(){const el=document.createElement("div");el.className="msg thinking";el.id="thinking-indicator";el.innerHTML='Dodo is thinking<span class="thinking-dots"></span>';$("chat").appendChild(el);const chat=$("chat");chat.scrollTo({top:chat.scrollHeight,behavior:"smooth"})}
function hideThinking(){$("thinking-indicator")?.remove()}
function useExample(el){if(!currentSession){createSession().then(()=>{$("msg-input").value=el.textContent;autoResizeInput($("msg-input"))});return}$("msg-input").value=el.textContent;autoResizeInput($("msg-input"));$("msg-input").focus()}
