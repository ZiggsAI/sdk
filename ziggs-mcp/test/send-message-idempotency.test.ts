import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createZiggsMcpServer} from '../src/server.js';
import type {ZiggsMcpConfig} from '../src/config.js';
import {callZiggsTool,callJson} from './support/surface.js';
const deviceKey=`header.${Buffer.from(JSON.stringify({type:'operator',keyId:'key',ownerId:'owner',boundAgentId:'assistant',issuedVia:'device_code'})).toString('base64url')}.test`;
for(const host of ['ChatGPT','Claude','compact']) test(`${host} forwards one canonical command and preserves retries and refusals`,async t=>{
 const server=createZiggsMcpServer({operatorKey:host==='compact'?'op':deviceKey,agentId:'assistant'},{directConnection:host==='compact',debugTools:false} as ZiggsMcpConfig);
 const[ct,st]=InMemoryTransport.createLinkedPair();const client=new Client({name:host,version:'test'});await Promise.all([server.connect(st),client.connect(ct)]);t.after(async()=>{await client.close();await server.close()});
 const command={operationId:'retry',content:{text:'Hello'},audience:{kind:'explicit',principalIds:['recipient','silent']},deliveries:{kind:'explicit',principalIds:['recipient']},effect:{kind:'request-answers',requests:[{requestId:'reply',responsiblePrincipalId:'recipient'}]},mandate:{agreementId:'work'},sources:[{kind:'artifact',id:'input',sha256:'a'.repeat(64)}]};
 const calls:unknown[]=[];let status=201;
 t.mock.method(globalThis,'fetch',async(url:unknown,init?:RequestInit)=>{assert.ok(String(url).endsWith('/messaging/messages'));calls.push(JSON.parse(String(init?.body)));return Response.json(status===201?{outcome:calls.length===1?'created':'existing',message:{messageId:'canonical',content:command.content,recipients:[],requestedAnswers:[]}}:{message:'Conflict'},{status})});
 for(let i=0;i<2;i++){const result=callJson(await callZiggsTool(client,'ziggs_message_send',{command}));assert.equal((result.message as any).messageId,'canonical')}
 assert.deepEqual(calls,[command,command]);
 status=409;const refused=await callZiggsTool(client,'ziggs_message_send',{command});assert.equal((refused as {isError?:boolean}).isError,true);
 const invalid=await callZiggsTool(client,'ziggs_message_send',{command:{...command,addressId:'retired'}});assert.equal((invalid as {isError?:boolean}).isError,true);assert.equal(calls.length,3);
 const names=(await client.listTools()).tools.map(t=>t.name);assert.ok(names.includes('ziggs_message_send'));assert.ok(!names.includes(['ziggs','chat','send'].join('_')));
});
