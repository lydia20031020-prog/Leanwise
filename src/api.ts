import type { AppData, MealItem } from './model';
export type ApiStatus = { configured:boolean; provider?:string; model?:string };
async function request<T>(path:string, body?:unknown):Promise<T> {
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),95000);
  try {
    const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:controller.signal});
    const result=await response.json().catch(()=>({error:'服务器返回了无法读取的响应'}));
    if(!response.ok)throw new Error(typeof result.error==='string'?result.error:result.error?.message||result.message||'请求失败，请稍后重试');
    return result;
  }catch(e){if(e instanceof Error&&e.name==='AbortError')throw new Error('识别等待较久，请重试或先手动记录。');throw e;}finally{clearTimeout(timeout);}
}
export const getStatus=()=>request<ApiStatus>('/api/status');
export const analyzeFood=(text:string,image:string|undefined,data:AppData)=>request<{items:MealItem[],note:string,provider:string}>('/api/analyze',{text,image,memory:{products:data.products,recipes:data.recipes}});
export const askAdvisor=(question:string,context:unknown)=>request<{answer:string,provider:string}>('/api/advice',{question,context});
export const demoSync=(source:'xiaomi'|'huawei')=>request<{source:'xiaomi'|'huawei',activeCalories:number,syncedAt:string,coverageUntil:string,demo:true}>('/api/health/demo-sync',{source});
