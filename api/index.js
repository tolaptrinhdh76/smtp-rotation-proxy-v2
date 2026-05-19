const express=require('express'); const cors=require('cors'); const path=require('path');
const app=express(); app.use(cors()); app.use(express.json());
function apiAuth(req,res,next){ if(req.path==='/health') return next(); const s=req.headers['x-api-secret']; if(!s||s!==process.env.API_SECRET) return res.status(401).json({success:false,error:'Unauthorized'}); next(); }
app.use('/api',apiAuth,require('./routes/accounts'));
app.use('/api',apiAuth,require('./routes/rules'));
app.use('/api',apiAuth,require('./routes/stats'));
app.use('/api',apiAuth,require('./routes/test'));
app.use('/api',apiAuth,require('./routes/backup'));
app.use('/api',apiAuth,require('./routes/import-export'));
app.get('/api/health',require('./routes/health'));
app.use(express.static(path.join(process.cwd(),'ui')));
app.get('*',(_,res)=>res.sendFile(path.join(process.cwd(),'ui/index.html')));
module.exports=app;
