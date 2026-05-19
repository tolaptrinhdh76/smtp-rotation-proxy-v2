const PRESETS={gmail:{host:'smtp.gmail.com',port:465,secure:true},outlook:{host:'smtp-mail.outlook.com',port:587,secure:false},hotmail:{host:'smtp-mail.outlook.com',port:587,secure:false},yahoo:{host:'smtp.mail.yahoo.com',port:465,secure:true},zoho:{host:'smtp.zoho.com',port:465,secure:true},sendgrid:{host:'smtp.sendgrid.net',port:587,secure:false},mailgun:{host:'smtp.mailgun.org',port:587,secure:false},custom:null};
const slug=s=>String(s||'').toLowerCase().trim().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
const mask=p=>!p?'':p.length<=4?'****':'*'.repeat(Math.max(0,p.length-4))+p.slice(-4);
module.exports={PRESETS,slug,mask};
