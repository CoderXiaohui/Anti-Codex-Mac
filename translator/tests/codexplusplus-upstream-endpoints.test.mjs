import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverCodexPlusPlusUpstreamModels, testCodexPlusPlusUpstreamConnection} from '../provider/codexplusplus-upstream-probe.mjs';

for (const [baseUrl, expectedPath] of [
  ['https://provider.test/v1/chat/completions','/v1/models'],
  ['https://provider.test/v1/responses','/v1/models'],
  ['https://provider.test/gateway/v1/chat/completions/','/gateway/v1/models'],
  ['https://provider.test','/v1/models'],
]) {
  test(`model discovery accepts the same endpoint form as completion: ${new URL(baseUrl).pathname}`, async () => {
    const calls=[];
    const models=await discoverCodexPlusPlusUpstreamModels({protocol:'openai-compatible',baseUrl,apiKey:'synthetic'}, {fetchImpl:async url=>{
      calls.push(new URL(url).pathname);
      return new Response(JSON.stringify({data:[{id:'text-model'}]}),{status:200});
    }});
    assert.deepEqual(models,['text-model']);
    assert.deepEqual(calls,[expectedPath]);
  });
}

test('a failed Responses object is a failed connection even with HTTP 200', async () => {
  const stages=await testCodexPlusPlusUpstreamConnection({protocol:'responses',baseUrl:'https://provider.test/v1',model:'text-model',apiKey:'synthetic'}, {fetchImpl:async()=>new Response(JSON.stringify({object:'response',status:'failed',error:{code:'insufficient_quota',message:'No capacity'},output:[]}),{status:200})});
  assert.equal(stages.find(s=>s.stage==='模型连通')?.status,'fail');
});

test('a token-limited successful Responses probe still proves connectivity', async () => {
  const stages=await testCodexPlusPlusUpstreamConnection({protocol:'responses',baseUrl:'https://provider.test/v1',model:'text-model',apiKey:'synthetic'}, {fetchImpl:async()=>new Response(JSON.stringify({object:'response',status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[]}),{status:200})});
  assert.equal(stages.find(s=>s.stage==='模型连通')?.status,'ok');
});
