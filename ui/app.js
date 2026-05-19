const app=document.getElementById('app'); const health=document.getElementById('health');
let secret=sessionStorage.getItem('apiSecret')||prompt('API Secret'); if(secret) sessionStorage.setItem('apiSecret',secret);
async function api(path,opt={}){const r=await fetch('/api'+path,{...opt,headers:{'Content-Type':'application/json','X-API-Secret':secret,...(opt.headers||{})}}); if(r.status===401){sessionStorage.removeItem('apiSecret');location.reload(); throw new Error('401');} return r.json();}
async function renderAccounts(){const j=await api('/accounts'); app.innerHTML='<h2>Accounts</h2><pre>'+JSON.stringify(j.data,null,2)+'</pre>';}
async function renderRules(){const j=await api('/rules'); app.innerHTML='<h2>Rules</h2><pre>'+JSON.stringify(j.data,null,2)+'</pre>';}
async function renderStats(){const j=await api('/stats'); app.innerHTML='<h2>Stats</h2><pre>'+JSON.stringify(j.data,null,2)+'</pre>';}
async function renderSettings(){const j=await api('/settings'); app.innerHTML='<h2>Settings</h2><pre>'+JSON.stringify(j.data,null,2)+'</pre>';}
document.querySelectorAll('aside button').forEach(b=>b.onclick=()=>({accounts:renderAccounts,rules:renderRules,stats:renderStats,settings:renderSettings}[b.dataset.v])());
fetch('/api/health').then(r=>r.json()).then(j=>health.textContent=' • '+j.status);
renderAccounts();
