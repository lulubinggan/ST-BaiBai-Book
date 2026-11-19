import { afterEach, expect, it, vi } from 'vitest';
import * as context from '@/st/context';
import type { STContext } from '@/st/context';
import { channelTestHistory, requestCompletion, testChannel } from './client';
import { apiSettings, getChannelForTask, hydrateSettings, newVertexChannel } from './settings';
import { LEGACY_VERTEX_CHANNEL_ID } from './vertex';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('migrates the original assignment and routes standard and Flex channels using their own credentials', async () => {
  const flexChannel = { ...newVertexChannel(), model: 'gemini-3.5-flash', flex: true };
  const storedCredentials = new Map([
    ['vertex', { tauriSecretId: 'standard-secret-id' }],
    [flexChannel.id, { tauriSecretId: 'flex-secret-id' }],
  ]);
  vi.stubGlobal('__TAURITAVERN__', {});
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('indexedDB', {
    open: () => {
      const request = {
        onsuccess: () => {},
        result: {
          close: () => {},
          transaction: () => {
            const tx = {
              oncomplete: () => {},
              objectStore: () => ({ get: (id: string) => ({ result: storedCredentials.get(id) }) }),
            };
            queueMicrotask(() => tx.oncomplete());
            return tx;
          },
        },
      };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  });
  const extensionSettings = {
    baibai_book: {
      ui: {},
      assignments: { summary: LEGACY_VERTEX_CHANNEL_ID, resummary: LEGACY_VERTEX_CHANNEL_ID },
      vertex: { model: 'gemini-3.5-flash', location: 'global', maxTokens: 4096, timeoutSec: 0 },
    },
    baibai_api_channels: { revision: 1, channels: [] },
  };
  vi.spyOn(context, 'getContext').mockReturnValue({
    extensionSettings,
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
  } as unknown as STContext);
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'Synthetic summary' } }] }))
    .mockResolvedValueOnce(Response.json({
      choices: [{ message: { content: 'Test reply' } }],
      usageMetadata: { trafficType: 'ON_DEMAND_FLEX' },
    }))
    .mockResolvedValueOnce(Response.json({ error: { message: 'Access denied' } }, { status: 403 }));
  vi.stubGlobal('fetch', fetchMock);

  hydrateSettings();
  const standardChannel = getChannelForTask('summary');
  expect(standardChannel).toMatchObject({ id: LEGACY_VERTEX_CHANNEL_ID, provider: 'vertex', maxTokens: 4096 });
  expect(getChannelForTask('resummary')).toBe(standardChannel);
  expect(extensionSettings.baibai_book).not.toHaveProperty('vertex');
  apiSettings.vertexChannels.push(flexChannel);
  apiSettings.assignments.resummary = flexChannel.id;
  expect(getChannelForTask('resummary')?.id).toBe(flexChannel.id);

  const messages = [{ role: 'system' as const, content: 'Summarize the scene' }, { role: 'user' as const, content: 'Synthetic scene' }];
  if (!standardChannel) throw new Error('Missing migrated Vertex channel');
  expect(await requestCompletion(standardChannel, messages)).toBe('Synthetic summary');
  expect(await testChannel(flexChannel)).toMatchObject({ ok: true, message: expect.stringContaining('Flex 已确认') });
  expect(await testChannel(standardChannel)).toMatchObject({ ok: false, message: expect.stringContaining('403') });

  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(Array(3).fill('/api/backends/chat-completions/generate'));
  const [standardRequest, flexRequest] = fetchMock.mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
  expect(standardRequest).toMatchObject({ secret_id: 'standard-secret-id', max_tokens: 4096, messages, use_sysprompt: true });
  expect(standardRequest).not.toHaveProperty('custom_include_headers');
  expect(standardRequest).not.toHaveProperty('custom_include_body');
  expect(flexRequest.secret_id).toBe('flex-secret-id');
  expect(JSON.parse(flexRequest.custom_include_headers)).toMatchObject({ 'X-Vertex-AI-LLM-Shared-Request-Type': 'flex' });
  expect(channelTestHistory.value).toMatchObject([
    { mode: 'Vertex AI 标准', status: '失败' },
    { mode: 'Vertex AI Flex', status: '成功' },
  ]);
  expect(JSON.stringify(channelTestHistory.value)).not.toMatch(/secret-id|Test reply|Synthetic scene/);
});
