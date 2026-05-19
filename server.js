require('dotenv').config();
const net = require('net');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const Rotator = require('./rotator');
const config = require('./config');
const apiApp = require('./api');
const rotator = new Rotator(config);
const INT = Number(process.env.PORT_SMTP_INT || 2626);
const EXT = Number(process.env.PORT_SMTP_EXT || 2525);
function fixSmtpLine(line){const raw=line.replace(/\r?\n$/,''); let m=raw.match(/^MAIL FROM:([^<>\s][^\s\r\n]*)(\s.*)?$/i); if(m) return `MAIL FROM:<${m[1].trim()}>${m[2]||''}\r\n`; m=raw.match(/^RCPT TO:([^<>\s][^\s\r\n]*)(\s.*)?$/i); if(m) return `RCPT TO:<${m[1].trim()}>${m[2]||''}\r\n`; if(/^AUTH LOGIN\s+[^<].*/i.test(raw)) console.log('[SHIM] AUTH LOGIN non-standard'); return raw+'\r\n';}
const smtp = new SMTPServer({ ...config.smtpServer, logger:true, hideSTARTTLS:true, disableReverseLookup:true,
 onAuth(auth,session,cb){ const m=rotator.findAccountByEmail(auth.username); if(m && m.config.auth.pass===auth.password){ session.overrideAccountId=m.config.id; return cb(null,{user:auth.username}); } cb(null,{user:auth.username||'anonymous'}); },
 onData(stream,session,cb){ simpleParser(stream, async (err,parsed)=>{ if(err) return cb(err); try{ const email={from: parsed.from?.text||session.envelope?.mailFrom?.address,to:(parsed.to?.value||session.envelope?.rcptTo||[]).map(x=>x.address||x).join(', '),subject:parsed.subject||'',text:parsed.text,html:parsed.html,headers:{}}; ['message-id','in-reply-to','references','list-id','reply-to'].forEach(h=>{const v=parsed.headers.get(h); if(v) email.headers[h]=String(v);}); if(session.overrideAccountId) await rotator.sendWithAccount(email,session.overrideAccountId); else await rotator.send(email); cb(); }catch(e){cb(e);} }); }});
smtp.listen(INT,()=>console.log(`[SMTP] internal ${INT}`));
const shim=net.createServer((client)=>{ const started=Date.now(); const ip=client.remoteAddress; console.log(`[SHIM] Client ${ip} connected`); client.setTimeout(60000); const up=net.connect(INT,'127.0.0.1'); let b=''; client.on('data',(d)=>{b+=d.toString('utf8'); let i; while((i=b.indexOf('\n'))>=0){ const line=b.slice(0,i+1); b=b.slice(i+1); up.write(fixSmtpLine(line)); }}); up.on('data',(d)=>client.write(d)); const close=()=>{client.destroy();up.destroy();console.log(`[SHIM] Client ${ip} disconnected after ${Date.now()-started}ms`);}; client.on('timeout',close); client.on('error',close); up.on('error',close); client.on('close',close); up.on('close',close);});
shim.listen(EXT,()=>console.log(`[SHIM] listening ${EXT}`));
apiApp.listen(process.env.PORT_API||3000,()=>console.log(`[API] on ${process.env.PORT_API||3000}`));
let closing=false; async function shutdown(){ if(closing) return; closing=true; setTimeout(()=>process.exit(0),10000); smtp.close(()=>{}); shim.close(()=>{}); }
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
