const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const fallback = require('../config');
const statsFile = path.join(process.cwd(), 'stats.json');
let db = null;
function isFirebaseReady() { return !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_DATABASE_URL); }
if (isFirebaseReady()) {
  try {
    admin.initializeApp({ credential: admin.credential.cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }), databaseURL: process.env.FIREBASE_DATABASE_URL });
    db = admin.database().ref('smtp-proxy');
    console.log('[DB] Firebase initialized');
  } catch (e) { console.error('[DB] Firebase init error', e.message); }
}
const readStats = () => { try { return JSON.parse(fs.readFileSync(statsFile, 'utf8')); } catch { return {}; } };
const writeStats = (x) => fs.writeFileSync(statsFile, JSON.stringify(x, null, 2));
async function getAccounts(){try{ if(!db) return fallback.accounts; const v=(await db.child('accounts').get()).val()||{}; return Object.values(v).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)); }catch(e){console.error('[DB] getAccounts',e.message); return fallback.accounts; }}
async function setAccount(id,data){ if(!db) return data; await db.child(`accounts/${id}`).set(data); return data; }
async function deleteAccount(id){ if(!db) return; await db.child(`accounts/${id}`).remove(); }
async function getRules(){try{ if(!db) return fallback.rules; const v=(await db.child('rules').get()).val()||{}; return Object.values(v).sort((a,b)=>(a.order||999)-(b.order||999)); }catch(e){console.error('[DB] getRules',e.message); return fallback.rules; }}
async function setRule(id,data){ if(!db) return data; await db.child(`rules/${id}`).set(data); return data; }
async function deleteRule(id){ if(!db) return; await db.child(`rules/${id}`).remove(); }
async function getStats(){ if(!db) return readStats(); return (await db.child('stats').get()).val()||{}; }
async function updateStats(s){ if(!db) return writeStats(s); await db.child('stats').set(s); }
async function resetStats(accountId){ const s=await getStats(); if(accountId) s[accountId]={sentToday:0,sentHour:0,total:s[accountId]?.total||0,errors:s[accountId]?.errors||0,lastResetDay:Date.now(),lastResetHour:Date.now()}; else Object.keys(s).forEach(k=>{s[k]={...s[k],sentToday:0,sentHour:0,lastResetDay:Date.now(),lastResetHour:Date.now()};}); await updateStats(s); return s; }
async function getSettings(){ if(!db) return fallback.settings; return (await db.child('settings').get()).val()||fallback.settings; }
async function updateSettings(data){ if(!db) return data; await db.child('settings').update(data); return getSettings(); }
module.exports={isFirebaseReady,getAccounts,setAccount,deleteAccount,getRules,setRule,deleteRule,getStats,updateStats,resetStats,getSettings,updateSettings};
