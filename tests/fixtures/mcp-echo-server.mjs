// T4.1 测试用最小 MCP stdio server：行分隔 JSON-RPC 2.0
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const TOOLS = [
  { name: 'echo', description: 'Read and echo back the given text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'send_message', description: 'Send a message to an external channel', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
];

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification
  let result;
  if (msg.method === 'initialize') {
    result = { protocolVersion: '2025-06-18', serverInfo: { name: 'echo-server', version: '1.0.0' } };
  } else if (msg.method === 'tools/list') {
    result = { tools: TOOLS };
  } else if (msg.method === 'tools/call') {
    if (msg.params?.name === 'echo') {
      result = { content: [{ type: 'text', text: 'echo:' + String(msg.params?.arguments?.text || '') }], isError: false };
    } else if (msg.params?.name === 'send_message') {
      result = { content: [{ type: 'text', text: 'sent' }], isError: false };
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } }) + '\n');
      return;
    }
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
});
