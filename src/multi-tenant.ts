/**
 * Multi-tenant HTTP server mode.
 * Each session is authenticated via a per-account API key (from Supabase),
 * and gets its own isolated set of services — so one user can never see
 * or access another user's email account.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import ConnectionManager from './connections/manager.js';
import { bindServer, markInitialized, mcpLog } from './logging.js';
import registerAllPrompts from './prompts/register.js';
import registerAllResources from './resources/register.js';
import RateLimiter from './safety/rate-limiter.js';
import { getAccountsByApiKey } from './config/supabase-accounts.js';
import createServer, { PKG_VERSION } from './server.js';
import CalendarService from './services/calendar.service.js';
import HooksService from './services/hooks.service.js';
import ImapService from './services/imap.service.js';
import LocalCalendarService from './services/local-calendar.service.js';
import OAuthService from './services/oauth.service.js';
import RemindersService from './services/reminders.service.js';
import SchedulerService from './services/scheduler.service.js';
import SmtpService from './services/smtp.service.js';
import TemplateService from './services/template.service.js';
import WatcherService from './services/watcher.service.js';
import registerAllTools from './tools/register.js';
import type { AccountConfig, AppConfig } from './types/index.js';

function buildDefaultConfig(accounts: AccountConfig[]): AppConfig {
  return {
    settings: {
      rateLimit: 10,
      readOnly: false,
      watcher: { enabled: false, folders: ['INBOX'], idleTimeout: 1740 },
      hooks: {
        onNewEmail: 'none',
        preset: 'notification-only',
        autoLabel: false,
        autoFlag: false,
        batchDelay: 5,
        customInstructions: undefined,
        systemPrompt: undefined,
        rules: [],
        alerts: {
          desktop: false,
          sound: false,
          urgencyThreshold: 'high',
          webhookUrl: '',
          webhookEvents: ['urgent', 'high'],
        },
        autoCalendar: false,
        calendarName: '',
        calendarAlarmMinutes: 15,
        calendarConfirm: true,
      },
    },
    accounts,
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function extractApiKey(req: IncomingMessage): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  const url = new URL(req.url ?? '', 'http://localhost');
  return url.searchParams.get('key') ?? undefined;
}

/** Builds a fully isolated set of services for a single authenticated user. */
async function buildSessionForApiKey(apiKey: string) {
  const accounts = await getAccountsByApiKey(apiKey);
  const config = buildDefaultConfig(accounts);

  const oauthService = new OAuthService();
  const connections = new ConnectionManager(config.accounts, oauthService);
  const rateLimiter = new RateLimiter(config.settings.rateLimit);
  const imapService = new ImapService(connections);
  const smtpService = new SmtpService(connections, rateLimiter, imapService);
  const templateService = new TemplateService();
  const calendarService = new CalendarService();
  const localCalendarService = new LocalCalendarService();
  const remindersService = new RemindersService();
  const schedulerService = new SchedulerService(smtpService, imapService);
  const watcherService = new WatcherService(config.settings.watcher, config.accounts);
  const hooksService = new HooksService(config.settings.hooks, imapService);

  const server = createServer();
  bindServer(server);
  registerAllTools(
    server,
    connections,
    imapService,
    smtpService,
    config,
    templateService,
    calendarService,
    localCalendarService,
    remindersService,
    schedulerService,
    watcherService,
    hooksService,
  );
  registerAllResources(server, connections, imapService, templateService, schedulerService);
  registerAllPrompts(server);

  return { server, connections, watcherService, hooksService };
}

export async function runMultiTenantHttpServer(port: number): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: PKG_VERSION }));
      return;
    }

    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    let body: unknown;
    if (req.method === 'POST') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString());
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }),
          );
          return;
        }
      }
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    let transport: StreamableHTTPServerTransport;

    const existing = sessionId ? transports.get(sessionId) : undefined;
    if (existing) {
      transport = existing;
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(body)) {
      const apiKey = extractApiKey(req);
      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Missing API key (Authorization: Bearer <key> or ?key=)' },
            id: null,
          }),
        );
        return;
      }

      let session: Awaited<ReturnType<typeof buildSessionForApiKey>>;
      try {
        session = await buildSessionForApiKey(apiKey);
      } catch (err) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: err instanceof Error ? err.message : String(err) },
            id: null,
          }),
        );
        return;
      }

      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, newTransport);
        },
      });
      newTransport.onclose = () => {
        const sid = newTransport.sessionId;
        if (sid) transports.delete(sid);
        void session.watcherService.stop();
        void session.connections.closeAll();
      };

      await session.server.connect(newTransport);

      const ls = session.server.server;
      ls.oninitialized = () => {
        markInitialized();
        // eslint-disable-next-line no-void
        void (async () => {
          try {
            const clientCaps = ls.getClientCapabilities?.() ?? {};
            session.hooksService.start(ls, { sampling: clientCaps.sampling != null });
            await mcpLog('info', 'server', 'Email MCP server ready (multi-tenant HTTP mode)');
          } catch (err) {
            process.stderr.write(
              `[email-mcp] hooks init error: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        })();
      };

      transport = newTransport;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: provide mcp-session-id or send an initialize request' },
          id: null,
        }),
      );
      return;
    }

    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, () => {
      process.stderr.write(`email-mcp multi-tenant HTTP server listening on :${port}\n`);
      process.stderr.write(`  Endpoint : http://0.0.0.0:${port}/mcp\n`);
      process.stderr.write(`  Health   : http://0.0.0.0:${port}/health\n`);
      resolve();
    });
    httpServer.once('error', reject);
  });

  const shutdown = async () => {
    await Promise.allSettled(Array.from(transports.values(), async (t) => t.close()));
    httpServer.close();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}