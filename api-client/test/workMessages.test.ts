import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageRecordsClient } from '../src/http/MessageRecordsClient.js';
import { ContextReadClient } from '../src/http/ContextReadClient.js';
import { withWorkExecutionId } from '../src/http/operatorHeaders.js';

test('controls are independent of history and retain explicit execution and task', async t => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string> });
    return Response.json({ canSend: true, recipients: [] });
  });
  await withWorkExecutionId('execution', () => new MessageRecordsClient('key', 'agent', 'http://test').controls('work/a', 'task/b'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://test/messaging/controls?agreementId=work%2Fa&taskId=task%2Fb');
  assert.equal(calls[0].headers['X-Ziggs-Execution'], 'execution');
});

test('a work snapshot needs a resource reference, never a dummy chat or lane', async t => {
  const urls: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    urls.push(new URL(String(url))); return Response.json({ history: [], agreements: [], agents: [], users: [] });
  });
  const client = new ContextReadClient('key', 'agent', 'http://test');
  await client.snapshot({ via: 'agreement:work', agreementId: 'work' });
  await client.snapshot({ via: 'task:task', agreementId: 'work' });
  await client.snapshot({ via: 'artifact:result' });
  assert.deepEqual(urls.map(u => u.searchParams.get('via')), ['agreement:work', 'task:task', 'artifact:result']);
  assert.ok(urls.every(u => !u.toString().includes('address')));
  await assert.rejects(client.snapshot({via:''}), /explicit resource/);
});

test('snapshot retains selected execution on refusal and never retries another scope', async t => {
  const calls: Array<{url: string; headers: Record<string,string>}> = [];
  t.mock.method(globalThis,'fetch',async(url:unknown, init:RequestInit)=>{
    calls.push({url:String(url),headers:init.headers as Record<string,string>});
    return new Response('revoked',{status:403});
  });
  const client=new ContextReadClient('key','agent','http://test');
  await assert.rejects(withWorkExecutionId('selected-execution',()=>client.snapshot({via:'task:exact-task',agreementId:'selected-work'})), /revoked/);
  assert.equal(calls.length,1);
  assert.equal(new URL(calls[0].url).searchParams.get('via'),'task:exact-task');
  assert.equal(new URL(calls[0].url).searchParams.get('agreementId'),'selected-work');
  assert.equal(calls[0].headers['X-Ziggs-Execution'],'selected-execution');
});

test('an exact message snapshot cannot inherit work or artifact selectors',async t=>{
 const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json({}));
 const client=new ContextReadClient('key','agent','http://test');
 for(const extra of [{agreementId:'other-work'},{artifactId:'other-file'}])
   await assert.rejects(client.snapshot({via:'message:exact',...extra}),/exact message independently/);
 assert.equal(fetch.mock.callCount(),0);
});
