import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MessageRecordsClient, type MessageCommand } from '../src/http/MessageRecordsClient.js';
import { withWorkExecutionId } from '../src/http/operatorHeaders.js';
import { readMessageCapability, queryMessagesCapability, sendMessageCapability } from '../src/capabilities/messaging.js';
const endpoint = (ref: string, isSelf = false) => ({ref, name: ref, kind: 'user', isSelf});
const message = (messageId = 'message/b') => ({messageId, timestamp: new Date().toISOString(), content: {text: 'Answer'}, sender: endpoint('sender'), readers: [endpoint('recipient')], recipients: [endpoint('recipient')], intent: 'fyi', relationships: {}, mandate: null});
const command = (over: Partial<MessageCommand> = {}): MessageCommand => ({operationId: 'stable', content: {text: 'Answer'}, audience: {kind: 'explicit', principalIds: ['recipient']}, deliveries: {kind: 'explicit', principalIds: ['recipient']}, intent: 'fyi', ...over});
afterEach(() => mock.restoreAll());
it('pages an anchored conversation without inventing participant or work selectors', async () => {
 const urls: string[] = [];
 mock.method(globalThis,'fetch',async(url:unknown)=>{urls.push(String(url));return Response.json({messages:[],nextCursor:null});});
 assert.equal(queryMessagesCapability.params?.conversationOf?.type, 'string');
 await queryMessagesCapability.handler({conversationOf:'message/anchor',before:'older',limit:40},{creds:{operatorKey:'key',agentId:'agent'},baseUrl:'http://test'});
 assert.deepEqual(urls,['http://test/messaging/messages?conversationOf=message%2Fanchor&before=older&limit=40']);
});
it('uses selected execution for canonical reads and sends without rewriting explicit scope', async () => {
 const calls: Array<{url:string;init?:RequestInit}> = [];
 mock.method(globalThis,'fetch',async (url: unknown,init?:RequestInit)=>{calls.push({url:String(url),init}); return Response.json(init?.method==='POST'?{outcome:'created',message:message()}:message());});
 const client = new MessageRecordsClient('key','agent','http://test');
 const input = command({mandate:{agreementId:'work/a',taskId:'task'},relationships:{replyToMessageId:'message/b'}});
 await withWorkExecutionId('selected',async()=>{await client.list({agreementId:'work/a',taskId:'task',before:'cursor',limit:12});await client.get('message/b');await client.send(input);});
 assert.equal(calls[0].url,'http://test/messaging/messages?agreementId=work%2Fa&taskId=task&before=cursor&limit=12');
 assert.equal(calls[1].url,'http://test/messaging/messages/message%2Fb');
 assert.equal(calls[2].url,'http://test/messaging/messages');
 assert.deepEqual(JSON.parse(String(calls[2].init?.body)), input);
 assert.ok(calls.every(c=>(c.init?.headers as Record<string,string>)['X-Ziggs-Execution']==='selected'));
});
it('preserves scoped refusals instead of returning empty history',async()=>{
 mock.method(globalThis,'fetch',async()=>Response.json({message:'Work audience changed'},{status:403}));
 await assert.rejects(new MessageRecordsClient('key','agent','http://test').list({agreementId:'work'}),(error:unknown)=>(error as {status:number}).status===403);
});
it('canonical tools call the runner backend they were given',async()=>{
 const urls:string[]=[];
 mock.method(globalThis,'fetch',async(url:unknown,init?:RequestInit)=>{urls.push(String(url));return Response.json(init?.method==='POST'?{outcome:'created',message:message('m')}:message('m'));});
 const env={creds:{operatorKey:'key',agentId:'agent'},baseUrl:'http://runner.test',surface:'sdk' as const};
 await queryMessagesCapability.handler({agreementId:'work',taskId:'task'},env);
 await readMessageCapability.handler({messageId:'m'},env);
 await sendMessageCapability.handler({command:command()},env);
 assert.deepEqual(urls,['http://runner.test/messaging/messages?agreementId=work&taskId=task','http://runner.test/messaging/messages/m','http://runner.test/messaging/messages']);
});
it('links never select recipients or work and an omitted delivery selection is rejected',async()=>{
 const sends:unknown[]=[];
 mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>{assert.equal(init?.method,'POST');sends.push(JSON.parse(String(init.body)));return Response.json({outcome:'created',message:message()});});
 const client=new MessageRecordsClient('key','agent','http://test');
 const input=command({relationships:{replyToMessageId:'question'},mandate:{agreementId:'work',taskId:'independent-task'}});
 await assert.rejects(client.send({...input,deliveries:undefined} as unknown as MessageCommand));
 await client.send(input);
 assert.deepEqual(sends,[input]);
});
it('exact source digests survive the tool and are part of the unchanged retry body',async()=>{
 const bodies:unknown[]=[];
 mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)));return Response.json({outcome:'existing',message:message()});});
 const input=command({sources:[{kind:'artifact',id:'page',sha256:'a'.repeat(64)}]});
 for(let i=0;i<2;i++) await sendMessageCapability.handler({command:input},{creds:{operatorKey:'key',agentId:'agent'},baseUrl:'http://test'});
 assert.deepEqual(bodies,[input,input]);
});
it('validates exact record identity and refuses superseded wire formats',async()=>{
 let row:unknown=message('wanted');
 mock.method(globalThis,'fetch',async()=>Response.json(row));
 const client=new MessageRecordsClient('key','agent','http://test');
 assert.equal((await client.get('wanted')).content.text,'Answer');
 row=message('different');await assert.rejects(client.get('wanted'),/Invalid exact/);
 row={messageId:'wanted',addressId:'old',text:'hello'};await assert.rejects(client.get('wanted'),/Invalid exact/);
});
it('never calls a malformed success body a successful command',async()=>{
 mock.method(globalThis,'fetch',async()=>Response.json({success:true,message:'ok'}));
 await assert.rejects(new MessageRecordsClient('key','agent','http://test').send(command()),/Invalid message command response/);
});
