import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const app = createMcpExpressApp();
const sessions = new Map();
function newServer() {
  const server = new McpServer({ name: 'orchestra-http-fixture', version: '1.0.0' });
  server.registerTool('echo', { description: 'Echo through fixture HTTP.', inputSchema: { message: z.string() } }, async ({ message }) => ({ content: [{ type: 'text', text: message }] }));
  return server;
}
app.post('/mcp', async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.ORCHESTRA_FIXTURE_TOKEN}`) return res.status(401).end();
  const id = req.headers['mcp-session-id'];
  let transport = id ? sessions.get(id) : null;
  if (!transport && !id && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: sessionId => sessions.set(sessionId, transport) });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await newServer().connect(transport);
    return transport.handleRequest(req, res, req.body);
  }
  if (!transport) return res.status(404).end();
  return transport.handleRequest(req, res, req.body);
});
app.get('/mcp', async (req, res) => {
  const transport = sessions.get(req.headers['mcp-session-id']);
  if (!transport) return res.status(404).end();
  return transport.handleRequest(req, res);
});
app.delete('/mcp', async (req, res) => {
  const transport = sessions.get(req.headers['mcp-session-id']);
  if (!transport) return res.status(404).end();
  return transport.handleRequest(req, res);
});
const server = app.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
process.on('SIGTERM', () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
