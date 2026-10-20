import {createApp} from '../server/index.js';
import {once} from 'node:events';
const app=createApp();const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
for (const [name,body] of [
  ['text',{text:'200ml牛奶和一个水煮蛋',memory:{products:[{id:'milk-own',name:'我的全脂牛奶',unit:'ml',baseQuantity:240,kcal:160,protein:9,carbs:11,fat:9,aliases:['牛奶']}],recipes:[]}}],
  ['image',{text:'测试图片能力，请描述食物。',image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='}],
  ['advice',{question:'今天下一餐怎么安排？',context:{date:'2026-10-16',isComplete:false,profile:{dailyTarget:1750,targetWeight:62},todayTotals:{kcal:830,protein:52},meals:[{type:'早餐'},{type:'午餐'}],weights:[{date:'2026-10-16',value:66.8}],energy:{mode:'estimate',tdee:2100}}}],
]){
  const started=Date.now();
  try{const r=await fetch(base+'/api/'+(name==='advice'?'advice':'analyze'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();console.log(JSON.stringify({name,status:r.status,durationMs:Date.now()-started,code:j.code,error:j.error,itemCount:j.items?.length,answerPresent:!!j.answer}));}
  catch(e){console.log(JSON.stringify({name,error:'请求失败',type:e.name}));}
}
server.close();
