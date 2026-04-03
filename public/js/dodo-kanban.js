// dodo-kanban.js — Tasks, kanban cards, drag-and-drop, batch dispatch, session sync

let selectedTasks=new Set();
let allTasks=[];

async function loadTasks(){
  try{
    const{tasks}=await api("/api/tasks");allTasks=tasks;const board=$("task-board");
    const cols={backlog:[],todo:[],in_progress:[],done:[]};
    tasks.forEach(t=>{if(cols[t.status])cols[t.status].push(t);else if(t.status!=="cancelled")(cols.backlog).push(t)});
    selectedTasks.forEach(id=>{if(!tasks.find(t=>t.id===id))selectedTasks.delete(id)});
    // Status summary bar (always shown)
    const statusLabels={backlog:'Backlog',todo:'Todo',in_progress:'In Progress',done:'Done'};
    const summaryHtml=`<div class="kanban-summary">${Object.entries(cols).map(([s,items])=>`<span class="sum-col">${statusLabels[s]} <span class="sum-count">${items.length}</span></span>`).join('')}</div>`;
    // Only render columns that have tasks
    const activeCols=Object.entries(cols).filter(([,items])=>items.length>0);
    let kanbanHtml='';
    if(activeCols.length>0){
      kanbanHtml=`<div class="kanban">${activeCols.map(([status,items])=>{
        const colId='kanban-col-'+status;
        return `<div class="kanban-col" id="${colId}" data-status="${esc(status)}" ondragover="kanbanDragOver(event)" ondragleave="kanbanDragLeave(event)" ondrop="kanbanDrop(event,'${esc(status)}')"><h3>${esc(status.replace('_',' '))}<span class="col-count">${items.length}</span></h3>${items.map(t=>renderTaskCard(t,status)).join("")}</div>`}).join("")}</div>`;
    }
    board.innerHTML=summaryHtml+kanbanHtml;
    renderBatchBar();
  }catch{$("task-board").innerHTML='<div class="empty">No tasks</div>'}
}

function renderTaskCard(t,status){
  const sel=selectedTasks.has(t.id)?'selected':'';
  const priClass=t.priority==='high'?'high':t.priority==='low'?'low':'';
  const eid=esc(t.id);
  let primary='',overflow=[];
  if(status==='backlog'){
    primary=`<button class="sm back-btn" onclick="moveTask(event,'${eid}','todo')" title="Move to Todo">\u2192 Todo</button>`;
    overflow.push(`<button onclick="deleteTaskUI(event,'${eid}')">Delete</button>`);
  }else if(status==='todo'){
    primary=`<button class="sm dispatch" onclick="dispatchTaskUI(event,'${eid}')">Dispatch</button>`;
    overflow.push(`<button onclick="moveTask(event,'${eid}','backlog')">\u2190 Backlog</button>`);
    overflow.push(`<button class="del-btn" onclick="deleteTaskUI(event,'${eid}')">Delete</button>`);
  }else if(status==='in_progress'){
    primary=`<button class="sm done-btn" onclick="moveTask(event,'${eid}','done')">\u2713 Done</button>`;
    if(t.sessionId)primary+=`<a class="session-link" href="#" onclick="event.stopPropagation();selectSession('${esc(t.sessionId)}')">\u{1F4BB}</a>`;
    overflow.push(`<button class="del-btn" onclick="cancelTaskUI(event,'${eid}')">Cancel</button>`);
  }else if(status==='done'){
    overflow.push(`<button class="del-btn" onclick="deleteTaskUI(event,'${eid}')">Delete</button>`);
  }
  const overflowHtml=overflow.length?`<span class="overflow-menu"><button class="overflow-btn" onclick="toggleOverflow(event)" title="More">\u22EF</button><span class="overflow-items">${overflow.join('')}</span></span>`:'';
  return `<div class="kanban-card ${sel}" draggable="true" data-task-id="${eid}" onclick="toggleSelectTask(event,'${eid}')" ondragstart="kanbanDragStart(event,'${eid}')" ondragend="kanbanDragEnd(event)"><div class="card-title">${esc(t.title)}<span class="priority ${priClass}">${esc(t.priority)}</span></div><div class="card-actions">${primary}${overflowHtml}</div></div>`;
}

function renderBatchBar(){
  const bar=$("task-batch-bar");
  if(selectedTasks.size===0){bar.innerHTML='';return}
  const dispatchable=[];const deletable=[];
  selectedTasks.forEach(id=>{const t=allTasks.find(x=>x.id===id);if(!t)return;if(t.status==='backlog'||t.status==='todo')dispatchable.push(id);deletable.push(id)});
  bar.innerHTML=`<div class="kanban-batch"><span class="batch-info">${selectedTasks.size} selected</span>${dispatchable.length?`<button class="sm primary" onclick="batchDispatch()">\u25B6 Dispatch ${dispatchable.length}</button>`:''}<button class="sm danger" onclick="batchDelete()">Delete ${deletable.length}</button><button class="sm" onclick="clearSelection()">Clear</button></div>`;
}

function toggleSelectTask(e,id){
  if(e.target.closest('button')||e.target.closest('a'))return;
  if(e.ctrlKey||e.metaKey){
    if(selectedTasks.has(id))selectedTasks.delete(id);else selectedTasks.add(id);
  }else{
    if(selectedTasks.has(id)&&selectedTasks.size===1)selectedTasks.clear();
    else{selectedTasks.clear();selectedTasks.add(id)}
  }
  loadTasks();
}

function clearSelection(){selectedTasks.clear();loadTasks()}

async function createTask(){
  const title=$("task-title").value.trim();const desc=$("task-desc").value.trim();const priority=$("task-priority").value;
  if(!title)return;
  const r=await jsonSafe("/api/tasks",{title,description:desc,priority});
  if(r)toast('Task added','success');else toast('Failed to create task','error');
  $("task-title").value="";$("task-desc").value="";$("task-priority").value="medium";
  await loadTasks();
}

async function moveTask(e,id,toStatus){
  e.stopPropagation();
  await jsonSafe(`/api/tasks/${encodeURIComponent(id)}`,{status:toStatus},"PUT");
  await loadTasks();
}

async function dispatchTaskUI(e,id){
  e.stopPropagation();
  const task=allTasks.find(t=>t.id===id);if(!task)return;
  showConfirm(`Dispatch "${task.title}" to a new session? This will create a session and start the agent working on it.`,async()=>{
    toast('Dispatching task...','info');
    try{
      const res=await json(`/api/tasks/${encodeURIComponent(id)}/dispatch`,{});
      if(res.sessionId){
        toast('Task dispatched','success');
        await loadTasks();await loadSessions();
        selectSession(res.sessionId);
      }else{toast('Dispatch failed','error')}
    }catch(err){toast('Dispatch failed: '+(err.message||err),'error')}
  });
}

async function deleteTaskUI(e,id){
  e.stopPropagation();
  const task=allTasks.find(t=>t.id===id);
  showConfirm(`Delete "${task?task.title:'this task'}"?`,async()=>{
    await apiSafe(`/api/tasks/${encodeURIComponent(id)}`,{method:"DELETE"});
    selectedTasks.delete(id);
    await loadTasks();
  });
}

async function cancelTaskUI(e,id){
  e.stopPropagation();
  await jsonSafe(`/api/tasks/${encodeURIComponent(id)}`,{status:"cancelled"},"PUT");
  selectedTasks.delete(id);
  await loadTasks();
}

async function batchDispatch(){
  const ids=[];
  selectedTasks.forEach(id=>{const t=allTasks.find(x=>x.id===id);if(t&&(t.status==='backlog'||t.status==='todo'))ids.push(id)});
  if(!ids.length)return;
  showConfirm(`Dispatch ${ids.length} task${ids.length>1?'s':''} in parallel? Each will get its own session.`,async()=>{
    toast(`Dispatching ${ids.length} tasks...`,'info');
    try{
      const res=await json("/api/tasks/batch-dispatch",{taskIds:ids});
      const ok=res.results.filter(r=>r.sessionId).length;
      const fail=res.results.filter(r=>r.error).length;
      toast(`${ok} dispatched${fail?`, ${fail} failed`:''}`,(fail?'warning':'success'));
      selectedTasks.clear();
      await loadTasks();await loadSessions();
      const first=res.results.find(r=>r.sessionId);
      if(first)selectSession(first.sessionId);
    }catch(err){toast('Batch dispatch failed: '+(err.message||err),'error')}
  });
}

async function batchDelete(){
  const ids=[...selectedTasks];if(!ids.length)return;
  showConfirm(`Delete ${ids.length} task${ids.length>1?'s':''}?`,async()=>{
    for(const id of ids)await apiSafe(`/api/tasks/${encodeURIComponent(id)}`,{method:"DELETE"});
    selectedTasks.clear();
    await loadTasks();
    toast(`${ids.length} task${ids.length>1?'s':''} deleted`,'success');
  });
}

// --- Overflow menu ---
function toggleOverflow(e){
  e.stopPropagation();
  const menu=e.currentTarget.closest('.overflow-menu');
  const wasOpen=menu.classList.contains('open');
  document.querySelectorAll('.overflow-menu.open').forEach(m=>m.classList.remove('open'));
  if(!wasOpen)menu.classList.add('open');
}
document.addEventListener('click',()=>document.querySelectorAll('.overflow-menu.open').forEach(m=>m.classList.remove('open')));

// --- Drag and drop ---
function kanbanDragStart(e,id){e.target.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',id)}
function kanbanDragEnd(e){e.target.classList.remove('dragging');document.querySelectorAll('.kanban-col').forEach(c=>c.classList.remove('drag-over'))}
function kanbanDragOver(e){e.preventDefault();e.dataTransfer.dropEffect='move';e.currentTarget.classList.add('drag-over')}
function kanbanDragLeave(e){e.currentTarget.classList.remove('drag-over')}
async function kanbanDrop(e,targetStatus){
  e.preventDefault();e.currentTarget.classList.remove('drag-over');
  const id=e.dataTransfer.getData('text/plain');if(!id)return;
  const task=allTasks.find(t=>t.id===id);if(!task||task.status===targetStatus)return;
  if(targetStatus==='in_progress'&&task.status!=='in_progress'){
    showConfirm(`Dispatch "${task.title}" to a new session?`,async()=>{
      toast('Dispatching task...','info');
      try{
        const res=await json(`/api/tasks/${encodeURIComponent(id)}/dispatch`,{});
        if(res.sessionId){toast('Task dispatched','success');await loadTasks();await loadSessions();selectSession(res.sessionId)}
      }catch(err){toast('Dispatch failed','error')}
    });
    return;
  }
  if(targetStatus==='cancelled'){
    await jsonSafe(`/api/tasks/${encodeURIComponent(id)}`,{status:'cancelled'},"PUT");
    await loadTasks();return;
  }
  await jsonSafe(`/api/tasks/${encodeURIComponent(id)}`,{status:targetStatus},"PUT");
  await loadTasks();
}

// --- Task-Session Sync ---
let taskSyncTimer=null;
function startTaskSync(){
  if(taskSyncTimer)clearInterval(taskSyncTimer);
  taskSyncTimer=setInterval(syncTaskSessions,30000);
}
async function syncTaskSessions(){
  if(!allTasks.length)return;
  const inProgress=allTasks.filter(t=>t.status==='in_progress'&&t.sessionId);
  if(!inProgress.length)return;
  let changed=false;
  for(const task of inProgress){
    try{
      const session=await apiSafe(`/session/${task.sessionId}`);
      if(!session)continue;
      if(session.status==='idle'&&session.messageCount>1){
        const promptData=await apiSafe(`/session/${task.sessionId}/prompts`);
        if(!promptData||!promptData.prompts)continue;
        const dispatched=promptData.prompts[0];
        if(!dispatched)continue;
        if(dispatched.status==='completed'){
          await jsonSafe(`/api/tasks/${encodeURIComponent(task.id)}`,{status:'done'},"PUT");
          toast({title:'Task completed',description:task.title},'success');
          changed=true;
        }else if(dispatched.status==='failed'){
          await jsonSafe(`/api/tasks/${encodeURIComponent(task.id)}`,{status:'backlog'},"PUT");
          toast({title:'Task failed — moved back to backlog',description:task.title},'warning');
          changed=true;
        }
      }
    }catch{/* ignore individual failures */}
  }
  if(changed)await loadTasks();
}
