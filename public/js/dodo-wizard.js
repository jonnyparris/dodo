// dodo-wizard.js — Onboarding wizard

const WIZARD_STEPS=["welcome","gateway","passkey","secrets","memory","integrations","complete"];

async function checkOnboarding(){
  try{
    const{completed,step}=await api("/api/onboarding/status");
    if(!completed)showWizard(step);
  }catch{}
}

function showWizard(step){
  $("wizard-overlay").style.display="flex";
  renderWizardStep(step);
}

function hideWizard(){
  $("wizard-overlay").style.display="none";
}

function renderWizardDots(currentStep){
  const idx=WIZARD_STEPS.indexOf(currentStep);
  $("wizard-dots").innerHTML=WIZARD_STEPS.map((s,i)=>`<div class="dot ${i===idx?'active':i<idx?'done':''}"></div>`).join("");
}

function renderWizardStep(step){
  renderWizardDots(step);
  const body=$("wizard-body");
  switch(step){
    case "welcome":
      var _fav=getTheme()==='dark'?'/favicon-dark.svg':'/favicon-light.svg';
      body.innerHTML=`<img src="${_fav}" alt="Dodo" class="dodo-logo md dodo-logo-img" style="margin-bottom:12px"/><h3>Welcome to Dodo</h3><p>Dodo is a self-hostable platform for dispatching long-running autonomous coding agents on Cloudflare Workers. Let's get you set up in a few quick steps.</p><p style="font-size:12px">You can skip any step and configure it later from the sidebar.</p><div class="wizard-actions"><button class="primary" onclick="advanceWizard('welcome',false)">Continue</button></div>`;
      break;
    case "gateway":
      body.innerHTML=`<h3>AI Provider</h3><p>Dodo needs an AI provider to work. Choose a gateway and configure your API credentials.</p><div style="max-width:360px;margin:0 auto;text-align:left"><label for="wiz-gateway" style="font-size:11px;color:var(--muted)">Gateway</label><select id="wiz-gateway" style="margin-bottom:8px" onchange="wizGatewayChanged()"><option value="ai-gateway">AI Gateway (Cloudflare)</option><option value="opencode">OpenCode Gateway</option></select><div id="wiz-gateway-fields"><label for="wiz-gw-url" style="font-size:11px;color:var(--muted)">AI Gateway Base URL</label><input id="wiz-gw-url" placeholder="https://gateway.ai.cloudflare.com/v1/YOUR_ACCOUNT/YOUR_GATEWAY" style="margin-bottom:8px"/><label for="wiz-gw-model" style="font-size:11px;color:var(--muted)">Model ID</label><input id="wiz-gw-model" placeholder="openai/gpt-5.4" value="openai/gpt-5.4" style="margin-bottom:8px"/></div></div><p style="font-size:11px;color:var(--muted)">You must bring your own AI provider. <a href="https://developers.cloudflare.com/ai-gateway/" target="_blank" rel="noopener noreferrer" style="color:var(--text-link)">Set up an AI Gateway</a> or use any OpenAI-compatible endpoint.</p><div class="wizard-actions"><button class="primary" onclick="wizardSaveGateway()">Save &amp; Continue</button></div>`;
      break;
    case "passkey":
      body.innerHTML=`<h3>Set a Passkey</h3><p>A passkey protects your secrets (API tokens, etc.) with envelope encryption. You can skip this and set one later.</p><label for="wiz-passkey" class="visually-hidden">Passkey, minimum 4 characters</label><input type="password" id="wiz-passkey" placeholder="Passkey (min 4 characters)" style="max-width:320px;margin:0 auto;display:block"/><div class="wizard-actions"><button class="primary" onclick="wizardSetPasskey()">Set Passkey</button><button onclick="advanceWizard('passkey',true)">Skip</button></div>`;
      break;
    case "secrets":
      body.innerHTML=`<h3>Add Tokens</h3><p>Add your GitHub or GitLab token so Dodo can push/pull code on your behalf. These are encrypted at rest.</p><div style="max-width:320px;margin:0 auto;text-align:left"><label for="wiz-github" style="font-size:11px;color:var(--muted)">GitHub Token</label><input type="password" id="wiz-github" placeholder="ghp_..." style="margin-bottom:8px"/><label for="wiz-gitlab" style="font-size:11px;color:var(--muted)">GitLab Token</label><input type="password" id="wiz-gitlab" placeholder="glpat-..." style="margin-bottom:8px"/></div><div class="wizard-actions"><button class="primary" onclick="wizardSetSecrets()">Save Tokens</button><button onclick="advanceWizard('secrets',true)">Skip</button></div>`;
      break;
    case "memory":
      body.innerHTML=`<h3>Memory</h3><p>Dodo has a built-in persistent memory store. You can also connect an external Memory MCP server for richer cross-session memory.</p><p style="font-size:12px"><a href="https://github.com/jonnyparris/agent-memory-mcp" target="_blank" rel="noopener noreferrer" style="color:var(--text-link)">Agent Memory MCP setup guide</a></p><div class="wizard-actions"><button class="primary" onclick="advanceWizard('memory',false)">Continue</button><button onclick="advanceWizard('memory',true)">Skip</button></div>`;
      break;
    case "integrations":
      body.innerHTML=`<h3>Integrations</h3><p>Extend Dodo with MCP servers for GitHub, Cloudflare, Sentry, and more. Configure them in the Integrations panel after setup.</p><div id="wiz-catalog" style="text-align:left;max-width:360px;margin:0 auto"></div><div class="wizard-actions"><button class="primary" onclick="advanceWizard('integrations',false)">Continue</button><button onclick="advanceWizard('integrations',true)">Skip</button></div>`;
      loadWizardCatalog();
      break;
    case "complete":
      body.innerHTML=`<h3>You're all set!</h3><p>Dodo is ready to go. Create a session and start building.</p><div class="wizard-actions"><button class="primary" onclick="finishWizard()">Get Started</button></div>`;
      break;
  }
}

async function loadWizardCatalog(){
  try{
    const catalog=await api("/api/mcp-catalog");
    const el=$("wiz-catalog");
    if(el)el.innerHTML=catalog.map(c=>`<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px"><strong>${esc(c.name)}</strong> — <span style="color:var(--muted)">${esc(c.description)}</span></div>`).join("");
  }catch{}
}

async function advanceWizard(step,skip){
  try{
    const next=await json("/api/onboarding/advance",{step,skip});
    if(next.currentStep==="complete"){renderWizardStep("complete")}
    else{renderWizardStep(next.currentStep)}
  }catch(e){toast("Error: "+(e.message||e),"error")}
}

function wizGatewayChanged(){
  const gw=$("wiz-gateway")?.value;
  const fields=$("wiz-gateway-fields");
  if(!fields)return;
  if(gw==="opencode"){
    fields.innerHTML=`<label for="wiz-gw-url" style="font-size:11px;color:var(--muted)">OpenCode Base URL</label><input id="wiz-gw-url" placeholder="https://your-opencode-gateway.com/compat" style="margin-bottom:8px"/><label for="wiz-gw-model" style="font-size:11px;color:var(--muted)">Model ID</label><input id="wiz-gw-model" placeholder="openai/gpt-5.4" value="openai/gpt-5.4" style="margin-bottom:8px"/>`;
  }else{
    fields.innerHTML=`<label for="wiz-gw-url" style="font-size:11px;color:var(--muted)">AI Gateway Base URL</label><input id="wiz-gw-url" placeholder="https://gateway.ai.cloudflare.com/v1/YOUR_ACCOUNT/YOUR_GATEWAY" style="margin-bottom:8px"/><label for="wiz-gw-model" style="font-size:11px;color:var(--muted)">Model ID</label><input id="wiz-gw-model" placeholder="openai/gpt-5.4" value="openai/gpt-5.4" style="margin-bottom:8px"/>`;
  }
}

async function wizardSaveGateway(){
  const gw=$("wiz-gateway")?.value||"ai-gateway";
  const url=$("wiz-gw-url")?.value?.trim();
  const model=$("wiz-gw-model")?.value?.trim()||"openai/gpt-5.4";
  if(!url){toast('Gateway URL is required','error');return}
  try{
    const body={activeGateway:gw,model};
    if(gw==="ai-gateway")body.aiGatewayBaseURL=url;
    else body.opencodeBaseURL=url;
    await json("/api/config",body,"PUT");
    toast('Gateway configured','success');
    await loadConfig();
    await advanceWizard("gateway",false);
  }catch(e){toast('Failed to save gateway: '+(e.message||e),'error')}
}

async function wizardSetPasskey(){
  const passkey=$("wiz-passkey")?.value;
  if(!passkey||passkey.length<4)return toast("Passkey must be at least 4 characters","warning");
  try{
    await json("/api/passkey/init",{passkey});
    await loadPasskeyStatus();
    await advanceWizard("passkey",false);
  }catch(e){toast("Failed: "+(e.message||e),"error")}
}

async function wizardSetSecrets(){
  const github=$("wiz-github")?.value?.trim();
  const gitlab=$("wiz-gitlab")?.value?.trim();
  try{
    if(github)await json("/api/secrets/github_token",{value:github},"PUT");
    if(gitlab)await json("/api/secrets/gitlab_token",{value:gitlab},"PUT");
    await loadSecrets();
    await advanceWizard("secrets",!github&&!gitlab);
  }catch(e){toast("Failed: "+(e.message||e),"error")}
}

async function skipOnboarding(){
  try{
    const state=await api("/api/onboarding");
    let current=state.currentStep;
    while(current!=="complete"){
      try{
        const next=await json("/api/onboarding/advance",{step:current,skip:true});
        current=next.currentStep;
      }catch{
        renderWizardStep(current);
        return;
      }
    }
  }catch{}
  hideWizard();
}

function finishWizard(){
  hideWizard();
  loadPasskeyStatus();loadSecrets();loadIntegrations();
}
