import test from 'node:test';
import assert from 'node:assert/strict';
import {matchFollowUpConversation,messageSignature} from '../antigravity-contract.mjs';

test('a generic assistant answer cannot merge unrelated automatic conversations',()=>{
  const anchor={role:'assistant',content:'OK'};
  const conversation={continuation:{},registeredToolNames:new Set(),baseSignatures:[messageSignature({role:'user',content:'private task A'})],lastAssistantSignature:messageSignature(anchor)};
  const request={tools:[],history:[{role:'user',content:'unrelated task B'},anchor],userItems:[{text:'continue'}]};
  assert.equal(matchFollowUpConversation(conversation,request),null);
});

test('a verified same-thread key may use its retained answer after history compaction',()=>{
  const anchor={role:'assistant',content:'task A unique answer'};
  const conversation={continuation:{},registeredToolNames:new Set(),baseSignatures:[messageSignature({role:'user',content:'large old task A'})],lastAssistantSignature:messageSignature(anchor)};
  const request={tools:[],history:[{role:'user',content:'compacted task A'},anchor],userItems:[{text:'continue'}],allowCompactedHistory:true};
  assert.deepEqual(matchFollowUpConversation(conversation,request),[{text:'continue'}]);
});
