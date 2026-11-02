import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ContextOpenClient} from '../src/http/ContextOpenClient.js';
import {accessRequestCapability,openCapability,contextDiscoverGrantableCapability,contextDelegateCapability} from '../src/capabilities/context.js';
import {withWorkExecutionId} from '../src/http/operatorHeaders.js';
const env={surface:'mcp' as const,creds:{operatorKey:'op',agentId:'agent'},baseUrl:'http://test'};

test('known room refs and aliases refuse locally without guessing a replacement',async t=>{
 const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json({}));
 const client=new ContextOpenClient('op','agent','http://test');
 for(const body of [{addressId:'room'},{ref:'C9HDF24'},{ref:'https://ziggsai.com/app/open/C9HDF24'},{ref:'eufateaglljwkqosgycqxhbj'},{ref:'address:old'},{ref:'chat:old'}]) {
   await assert.rejects(client.open(body as never),/retired/);
   await assert.rejects(client.explain(body as never),/retired/);
 }
 assert.equal(fetch.mock.callCount(),0);
});

test('open refusal preserves exact execution and makes no replacement request',async t=>{
 const calls:Array<{body:unknown;headers:Record<string,string>}>=[];
 t.mock.method(globalThis,'fetch',async(_url:unknown, init:RequestInit)=>{calls.push({body:JSON.parse(String(init.body)),headers:init.headers as Record<string,string>});return new Response('revoked',{status:403});});
 await assert.rejects(withWorkExecutionId('selected',()=>new ContextOpenClient('op','agent','http://test').open({taskId:'task-1'})),/revoked/);
 assert.equal(calls.length,1);assert.deepEqual(calls[0].body,{taskId:'task-1'});assert.equal(calls[0].headers['X-Ziggs-Execution'],'selected');
});

test('an opaque reference resolved as a room never exposes owner content or actions',async t=>{
 const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json({outcome:'ok',ref:{kind:'address',id:'opaque-resource'},access:{summary:'private room'},page:{items:[{body:'private history'}]},actions:[{tool:'room_join'}]}));
 const client=new ContextOpenClient('op','agent','http://test');
 for(const operation of ['open','explain'] as const) {
   await assert.rejects(client[operation]({ref:'opaque-resource'}),error=>{
     assert.equal((error as {code?:string}).code,'INVALID_INPUT');
     assert.match(String(error),/retired/);
     assert.doesNotMatch(String(error),/private history|private room|room_join/);
     return true;
   });
 }
 assert.equal(fetch.mock.callCount(),2);
});

test('access requests reject retired scope, reply/history and output destination choices before HTTP',async t=>{
 const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json({}));
 const request={scopeKind:'artifact',scopeId:'file',reason:'Review',holders:[{kind:'agent',id:'agent'}]};
 for(const extra of [{scopeKind:'address'},{scopeKind:'person',permission:'read'},{scopeKind:'person',permission:'list'},{permission:'reply'},{permission:'list'},{temporal:'from-now'},{contributionTo:{kind:'address',id:'old'}}]) await assert.rejects(accessRequestCapability.handler({...request,...extra},env));
 for(const scopeKind of ['address','person']) await assert.rejects(contextDelegateCapability.handler({parentGrantId:'grant',holderId:'agent',scopeKind,scopeId:'old',temporal:'from-start'},env));
 assert.equal(fetch.mock.callCount(),0);
});

test('message approvals resume through the message owner and do not open a room',async t=>{
 let body:Record<string,unknown>={};
 t.mock.method(globalThis,'fetch',async(_url:unknown, init:RequestInit)=>{body=JSON.parse(String(init.body));return Response.json({status:'pending_approval',agreementId:'approval',accessGranted:false,scope:{kind:'message',id:'message-1'}});});
 const result=await accessRequestCapability.handler({scopeKind:'message',scopeId:'message-1',reason:'Read the source'},env) as any;
 assert.equal(body.scopeKind,'message');assert.deepEqual(result.resumeAfterApproval,{tool:'ziggs_message_read',args:{messageId:'message-1'}});assert.equal(result.accessGranted,false);
 t.mock.method(globalThis,'fetch',async()=>Response.json({outcome:'ok',ref:{kind:'agreement',id:'approval'},access:{},page:{items:[{status:'active',grantRequest:{primitive:'context',kind:'access-request',holderId:'agent',scope:{kind:'message',id:'message-1'}}},{status:'active',grantRequest:{primitive:'context',kind:'access-request',holderId:'agent',scope:{kind:'address',id:'retired'}}}]}}));
 const approved=await openCapability.handler({agreementId:'approval-agreement'},env) as any;
 assert.equal(approved.actions.length,1);assert.equal(approved.actions[0].tool,'ziggs_message_read');assert.deepEqual(approved.actions[0].args,{messageId:'message-1'});
});

test('exact artifact consent preserves retained destinations and source provenance',async t=>{
 const sent:Record<string,unknown>[]=[];
 t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{sent.push(JSON.parse(String(init.body)));return Response.json({status:'pending_approval',agreementId:'consent',accessGranted:false});});
 for(const kind of ['message','agreement']) await accessRequestCapability.handler({scopeKind:'artifact',scopeId:'output',reason:'Approved output',holders:[{kind:'agent',id:'agent'}],contributionTo:{kind,id:'destination'},releaseSource:{kind:'address',id:'historical-source'}},env);
 assert.deepEqual(sent.map(row=>row.permission),['read','read']);
 assert.deepEqual(sent.at(-1)?.releaseSource,{kind:'address',id:'historical-source'});
});

test('discovery preserves owner references but offers no invalid address request action',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({items:[{type:'address',scopeRef:{kind:'address',id:'retired'}},{type:'agreement',scopeRef:{kind:'agreement',id:'work'}}]}));
 const result=await contextDiscoverGrantableCapability.handler({},env) as any;
 assert.equal(result.items.length,2);assert.deepEqual(result.items[0].actions,[]);assert.equal(result.items[1].actions[0].args.scopeKind,'agreement');
});
