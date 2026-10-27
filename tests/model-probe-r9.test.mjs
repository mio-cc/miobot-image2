import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelClient } from '../dist/packages/model/src/index.js';
import { reportExternalTaskFromHandler, runWithExternalTaskScope } from '../dist/packages/orchestration/src/index.js';

const node = { baseUrl: 'https://video.example/v1', apiKey: 'k', dialect: 'openai' };

function clientWith(responses) {
  const calls = [];
  const client = createModelClient({
    nodes: [node],
    retries: 0,
    transport: async (request) => {
      calls.push(request);
      return responses.shift();
    },
  });
  return { client, calls };
}

test('model R9: probeVideo performs one status request and maps success/pending/failure', async () => {
  const success = clientWith([{
    status: 200,
    data: { status: 'done', video: { url: 'https://cdn.example/video.mp4', mime_type: 'video/mp4' } },
  }]);
  const completed = await success.client.probeVideo(0, 'req_video_1');
  assert.equal(completed.status, 'success');
  assert.equal(completed.videos[0].kind, 'url');
  assert.equal(completed.videos[0].data, 'https://cdn.example/video.mp4');
  assert.equal(success.calls.length, 1);
  assert.equal(success.calls[0].method, 'GET');
  assert.match(success.calls[0].url, /videos\/req_video_1/);

  const pending = clientWith([{ status: 200, data: { status: 'pending', request_id: 'req_video_2' } }]);
  assert.equal((await pending.client.probeVideo(0, 'req_video_2')).status, 'running');

  const failed = clientWith([{ status: 200, data: { status: 'failed', error: { message: 'upstream failed' } } }]);
  const failedResult = await failed.client.probeVideo(0, 'req_video_3');
  assert.equal(failedResult.status, 'failed');
  assert.match(failedResult.error, /upstream failed/);
});

test('model R9: probeVideo preserves base64 video artifacts for the recovery bridge', async () => {
  const { client } = clientWith([{
    status: 200,
    data: { status: 'done', video: { b64_json: 'VklERU8=', mime_type: 'video/mp4' } },
  }]);
  const result = await client.probeVideo(0, 'req_video_4');
  assert.equal(result.status, 'success');
  assert.equal(result.videos[0].kind, 'base64');
  assert.equal(result.videos[0].data, 'VklERU8=');
  assert.equal(result.videos[0].mimeType, 'video/mp4');
});

test('model R9: video submit reports request_id immediately through the external task scope', async () => {
  const { client } = clientWith([{ status: 200, data: { request_id: 'req_submit_1' } }]);
  const reported = [];
  await runWithExternalTaskScope(
    { stepId: 'step_video', capability: 'video.generate', report: (taskId) => reported.push(taskId) },
    async () => {
      const result = await client.generateVideo(0, {
        model: 'grok-imagine-video',
        prompt: '海浪',
        waitForCompletion: false,
        onExternalTask: (taskId) => reportExternalTaskFromHandler(taskId),
      });
      assert.equal(result.pending, true);
      assert.equal(result.videos[0].requestId, 'req_submit_1');
    },
  );
  assert.deepEqual(reported, ['req_submit_1']);
});