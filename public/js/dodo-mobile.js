// dodo-mobile.js — Mobile tab switching, keyboard handling, swipe, scroll, overflow, collapsible, tooltip

// --- Mobile tab switching ---
function switchTab(tab){
  // Legacy alias: old code paths may still pass 'settings'; route them to 'sessions'.
  if(tab==='settings')tab='sessions';
  activeTab=tab;
  document.querySelectorAll('.mobile-nav button').forEach(b=>b.classList.remove('active'));
  document.querySelector(`.mobile-nav button[onclick="switchTab('${tab}')"]`)?.classList.add('active');
  const sidebar=$('sidebar-panel');
  const right=$('right-panel');
  const backdrop=$('mobile-backdrop');
  sidebar.classList.remove('mobile-visible');
  right.classList.remove('mobile-visible');
  if(backdrop)backdrop.classList.remove('visible');
  // Sessions drawer is partial-width so chat stays visible behind it.
  // Files/Tools are full-screen overlays so chat hides under them.
  const showChat=tab==='chat'||tab==='sessions';
  document.querySelector('.center').style.display=showChat?'flex':'none';
  const fab=document.querySelector('.fab');
  if(fab&&window.innerWidth<=900)fab.style.display=tab==='chat'?'none':'flex';
  const filesGroup=$('files-group');
  const toolsGroup=$('tools-group');
  if(filesGroup)filesGroup.style.display='';
  if(toolsGroup)toolsGroup.style.display='';
  if(tab==='sessions'){
    sidebar.classList.add('mobile-visible');
    if(backdrop)backdrop.classList.add('visible');
    // Focus the sessions search for keyboard users
    requestAnimationFrame(()=>$('session-search')?.focus());
  }
  if(tab==='files'){
    right.classList.add('mobile-visible');
    const title=$('right-panel-title');if(title)title.textContent='Files';
    if(toolsGroup)toolsGroup.style.display='none';
    right.scrollTop=0;
  }
  if(tab==='tools'){
    right.classList.add('mobile-visible');
    const title=$('right-panel-title');if(title)title.textContent='Tools';
    if(filesGroup)filesGroup.style.display='none';
    right.scrollTop=0;
  }
}

// --- Mobile keyboard handling ---
if(window.visualViewport){
  const nav=$("mobile-nav");
  const msgInput=$("msg-input");
  let initialHeight=window.visualViewport.height;
  let keyboardVisible=false;

  function handleViewportResize(){
    const currentHeight=window.visualViewport.height;
    const isOpen=currentHeight<initialHeight*0.7;
    if(isOpen!==keyboardVisible){
      keyboardVisible=isOpen;
      if(nav)nav.classList.toggle("keyboard-open",isOpen);
      if(isOpen){
        document.querySelector('.app').style.height=currentHeight-56+'px';
      }else{
        document.querySelector('.app').style.height='';
      }
    }
    if(isOpen&&document.activeElement===msgInput){
      requestAnimationFrame(()=>msgInput.scrollIntoView({block:"nearest",behavior:"smooth"}));
    }
  }

  window.visualViewport.addEventListener("resize",handleViewportResize);
  window.addEventListener("orientationchange",()=>{
    setTimeout(()=>{initialHeight=window.visualViewport.height},200);
  });
}

// --- Swipe between tabs (mobile) ---
(function(){
  if(window.innerWidth>900)return;
  // Tab order matches mobile-nav button order: swiping left advances right.
  const tabs=['sessions','chat','files','tools'];
  let touchStartX=0,touchStartY=0,swiping=false;
  const app=document.querySelector('.app');
  document.addEventListener('touchstart',(e)=>{
    touchStartX=e.touches[0].clientX;touchStartY=e.touches[0].clientY;swiping=true;
    if(app){app.style.transition='none'}
  },{passive:true});
  document.addEventListener('touchmove',(e)=>{
    if(!swiping)return;
    const dx=e.touches[0].clientX-touchStartX;
    const dy=e.touches[0].clientY-touchStartY;
    if(Math.abs(dy)>Math.abs(dx)){swiping=false;if(app)app.style.transform=''}
    else if(app){app.style.transform=`translateX(${dx}px)`}
  },{passive:true});
  document.addEventListener('touchend',(e)=>{
    if(!swiping){if(app){app.style.transition='';app.style.transform=''}return}
    swiping=false;
    const dx=e.changedTouches[0].clientX-touchStartX;
    if(app){app.style.transition='transform 0.3s ease-out';app.style.transform=''}
    if(Math.abs(dx)<60)return;
    const currentIdx=tabs.indexOf(activeTab);
    if(dx<0&&currentIdx<tabs.length-1)switchTab(tabs[currentIdx+1]);
    else if(dx>0&&currentIdx>0)switchTab(tabs[currentIdx-1]);
  },{passive:true});
})();

// --- Scroll to bottom ---
function scrollChatToBottom(){const c=$("chat");c.scrollTo({top:c.scrollHeight,behavior:"smooth"})}
(function(){const c=$("chat");const btn=$("scroll-bottom-btn");if(!c||!btn)return;c.addEventListener("scroll",()=>{const dist=c.scrollHeight-c.scrollTop-c.clientHeight;btn.classList.toggle("visible",dist>150)})})();

// --- Overflow menu ---
function toggleOverflowMenu(e){e.stopPropagation();$('overflow-menu').classList.toggle('open')}
function closeOverflowMenu(){$('overflow-menu').classList.remove('open')}
document.addEventListener('click',()=>closeOverflowMenu());

// --- Collapsible animation ---
document.querySelectorAll('details').forEach(d=>{
  const summary=d.querySelector('summary');
  if(summary){summary.removeAttribute('style')}
  const children=[...d.childNodes].filter(n=>n!==summary&&n.nodeName!=='SUMMARY');
  if(children.length&&!d.querySelector('.collapsible-body')){
    const wrapper=document.createElement('div');wrapper.className='collapsible-body';
    children.forEach(c=>wrapper.appendChild(c));
    d.appendChild(wrapper);
  }
});

// --- Tooltip system ---
(function(){
  let tip=null;
  function show(e){
    const el=e.currentTarget;
    const text=el.dataset.tip;if(!text)return;
    if(tip)tip.remove();
    tip=document.createElement('div');tip.className='kumo-tip';tip.textContent=text;
    document.body.appendChild(tip);
    const r=el.getBoundingClientRect();
    tip.style.left=Math.min(r.left+r.width/2,window.innerWidth-tip.offsetWidth/2-8)+'px';
    const above=r.top-tip.offsetHeight-6;
    if(above>4){tip.style.top=above+'px'}else{tip.style.top=(r.bottom+6)+'px'}
    tip.style.transform='translateX(-50%)';
    requestAnimationFrame(()=>tip.classList.add('visible'));
  }
  function hide(){if(tip){tip.remove();tip=null}}
  document.querySelectorAll('[title]').forEach(el=>{
    const t=el.getAttribute('title');if(!t)return;
    el.dataset.tip=t;el.removeAttribute('title');
    el.addEventListener('mouseenter',show);el.addEventListener('mouseleave',hide);
    el.addEventListener('focus',show);el.addEventListener('blur',hide);
  });
})();
