// Phase 1 测试用最小 MCP streamable HTTP server（node:http，测试内直接 import）：
// - initialize 响应带 Mcp-Session-Id；带错/缺会话头的非 initialize 请求 → 404（会话失效语义）
// - tools/list 游标分页（两页，nextCursor='p2'）；tools/call echo 带 structuredContent
// - GET /mcp（text/event-stream）推送一个 notifications/tools/list_changed 事件后保持连接
// - invalidateSession() 模拟服务端会话过期（旧 session 请求回 404，initialize 发新 session）
import http from 'node:http';

const TOOLS = [
  { name: 'echo', description: 'Read and echo back the given text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'send_message', description: 'Send a message to an external channel', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'lookup', description: 'Query a record by id', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
];

export async function startMcpHttpServer() {
  let session = `sess-test-${Date.now()}`;
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
      return; // 保持连接打开
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let msg = null;
      try { msg = JSON.parse(body); } catch { /* 非 JSON 忽略 */ }
      requests.push({ method: msg?.method ?? null, session: req.headers['mcp-session-id'] ?? null, body: msg ?? null });
      if (!msg || msg.id === undefined) { res.writeHead(202); res.end(); return; } // notification（含服务器未识别请求）
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'http-echo', version: '1.0.0' } } }));
        return;
      }
      if (req.headers['mcp-session-id'] !== session) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Session not found' } }));
        return;
      }
      let result;
      if (msg.method === 'tools/list') {
        const cursor = msg.params?.cursor;
        const page = cursor === 'p2' ? TOOLS.slice(2) : TOOLS.slice(0, 2);
        result = { tools: page, ...(cursor === 'p2' ? {} : { nextCursor: 'p2' }) };
      } else if (msg.method === 'tools/call' && msg.params?.name === 'echo') {
        const text = String(msg.params?.arguments?.text || '');
        result = { content: [{ type: 'text', text: `echo:${text}` }], structuredContent: { echoed: text } };
      } else if (msg.method === 'tools/call') {
        result = { content: [{ type: 'text', text: 'sent' }] };
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    /** 服务器当前会话值（getter：invalidateSession 后为最新值）。 */
    get session() { return session; },
    invalidateSession() { session = `sess-test-${Date.now()}-new`; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
