import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MessageRecordsClient } from '../src/http/MessageRecordsClient.js';
test('canonical history pages use the exact before cursor and never a room delta',async t=>{
 const urls:URL[]=[];
 t.mock.method(globalThis,'fetch',async(url:unknown)=>{urls.push(new URL(String(url)));return Response.json({messages:[],nextCursor:null});});
 const client=new MessageRecordsClient('key','agent','https://api.example');
 await client.list({participantIds:['a','b'],limit:20});
 await client.list({participantIds:['a','b'],before:'cursor',limit:20});
 assert.equal(urls[0].pathname,'/messaging/messages');
 assert.equal(urls[0].searchParams.get('before'),null);
 assert.equal(urls[0].searchParams.get('direction'),null);
 assert.equal(urls[0].searchParams.get('participantIds'),'a,b');
 assert.equal(urls[1].searchParams.get('before'),'cursor');
});
