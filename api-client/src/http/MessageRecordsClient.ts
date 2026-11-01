import { parseMessageCommand } from '@ziggs-ai/contracts';
import type { MessageCommand, MessageCommandResult, MessageRecord, MessagingControls } from '@ziggs-ai/contracts';
import { buildOperatorHeaders } from './operatorHeaders.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { throwApiError } from '../shared/apiError.js';
export interface MessageQuery { q?:string;senderId?:string;recipientIds?:string[]; agreementId?:string;taskId?:string;participantIds?:string[];before?:string;limit?:number }
export interface MessagePage { messages:MessageRecord[];nextCursor:string|null }
/** One command and one representation, independent of navigation. */
export class MessageRecordsClient {
 constructor(private readonly operatorKey:string,private readonly agentId:string,private readonly baseUrl?:string){}
 private async request<T>(path:string,init:RequestInit={}):Promise<T>{const res=await fetch(`${this.baseUrl??getBackendUrl()}/messaging/${path}`,{...init,headers:{'content-type':'application/json',...buildOperatorHeaders(this.operatorKey,this.agentId)}});if(!res.ok)throwApiError(res,await res.text().catch(()=>''),`Messaging failed: ${res.status}`);return await res.json() as T;}
 async get(id:string):Promise<MessageRecord>{const row=await this.request<MessageRecord>(`messages/${encodeURIComponent(id)}`);if(row.messageId!==id||!row.content||!Array.isArray(row.requestedAnswers))throw new Error('Invalid exact message response');return row;}
 async send(command:MessageCommand):Promise<MessageCommandResult>{const result = await this.request<MessageCommandResult>('messages',{method:'POST',body:JSON.stringify(parseMessageCommand(command))}); if (!['created','existing'].includes(result.outcome) || !result.message?.messageId || !result.message.content || !Array.isArray(result.message.recipients) || !Array.isArray(result.message.requestedAnswers)) throw new Error('Invalid message command response'); return result;}
 list(input:MessageQuery={}):Promise<MessagePage>{const query=new URLSearchParams();for(const [key,value]of Object.entries(input))if(value!==undefined)query.set(key,Array.isArray(value)?value.join(','):String(value));return this.request(`messages?${query}`);}
 replies(id:string,input:{before?:string;limit?:number}={}):Promise<MessagePage>{const query=new URLSearchParams();for(const [key,value]of Object.entries(input))if(value!==undefined)query.set(key,String(value));return this.request(`messages/${encodeURIComponent(id)}/replies?${query}`);}
 controls(agreementId:string,taskId?:string):Promise<MessagingControls>{const query=new URLSearchParams({agreementId,...(taskId?{taskId}:{})});return this.request(`controls?${query}`);}
 answers(id:string):Promise<unknown>{return this.request(`messages/${encodeURIComponent(id)}/answers`);}
 cancelAnswer(id:string,requestId:string):Promise<{state:'cancelled'}>{return this.request(`messages/${encodeURIComponent(id)}/answers/${encodeURIComponent(requestId)}/cancel`,{method:'POST'});}
}
export type { MessageCommand,MessageCommandResult,MessageRecord } from '@ziggs-ai/contracts';
