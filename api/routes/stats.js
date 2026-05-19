const r=require('express').Router(); const db=require('../../db/firebase');
r.get('/stats',async(_,res)=>res.json({success:true,data:await db.getStats()}));
r.post('/stats/reset',async(req,res)=>res.json({success:true,data:await db.resetStats(req.body.accountId)}));
r.get('/settings',async(_,res)=>res.json({success:true,data:await db.getSettings()}));
r.put('/settings',async(req,res)=>res.json({success:true,data:await db.updateSettings(req.body)}));
module.exports=r;
