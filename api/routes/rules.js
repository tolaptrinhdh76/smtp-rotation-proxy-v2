const r=require('express').Router(); const db=require('../../db/firebase'); const {slug}=require('./helpers');
r.get('/rules',async(_,res)=>res.json({success:true,data:await db.getRules()}));
r.post('/rules',async(req,res)=>{const b=req.body; const id=slug(b.name); const rule={id,name:b.name,order:Number(b.order||999),match:b.match||{},accounts:b.accounts||[],enabled:b.enabled!==false}; await db.setRule(id,rule); res.json({success:true,data:rule});});
r.put('/rules/:id',async(req,res)=>{const rules=await db.getRules(); const old=rules.find(x=>x.id===req.params.id); if(!old) return res.status(404).json({success:false,error:'Not found'}); const next={...old,...req.body,id:old.id}; await db.setRule(old.id,next); res.json({success:true,data:next});});
r.delete('/rules/:id',async(req,res)=>{const rules=await db.getRules(); const enabled=rules.filter(x=>x.enabled!==false); if(enabled.length===1 && enabled[0].id===req.params.id) return res.status(400).json({success:false,error:'Cannot delete last default rule'}); await db.deleteRule(req.params.id); res.json({success:true,data:true});});
module.exports=r;
