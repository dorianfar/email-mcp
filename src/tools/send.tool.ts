/**
 * MCP tools: draft_email, confirm_send_email
 * Two-step flow: a draft must be prepared and shown to the user before anything can be sent.
 * Drafts are also scanned for sensitive content (financial info, passwords, etc).
 */

 import { randomUUID } from 'node:crypto';
 import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
 import { z } from 'zod';
 import audit from '../safety/audit.js';
 import { validateInputLength } from '../safety/validation.js';
 import { detectSensitiveContent, formatSensitiveWarning } from '../safety/sensitive-detector.js';
 
 import type SmtpService from '../services/smtp.service.js';
 
 type PendingDraft =
   | {
       kind: 'send';
       account: string;
       to: string[];
       subject: string;
       body: string;
       cc?: string[];
       bcc?: string[];
       html: boolean;
       createdAt: number;
     }
   | {
       kind: 'reply';
       account: string;
       emailId: string;
       mailbox: string;
       body: string;
       replyAll: boolean;
       html: boolean;
       createdAt: number;
     }
   | {
       kind: 'forward';
       account: string;
       emailId: string;
       mailbox: string;
       to: string[];
       body?: string;
       cc?: string[];
       createdAt: number;
     };
 
 const pendingDrafts = new Map<string, PendingDraft>();
 const DRAFT_TTL_MS = 15 * 60 * 1000; // 15 minutes
 
 function cleanExpiredDrafts(): void {
   const now = Date.now();
   for (const [id, draft] of pendingDrafts) {
     if (now - draft.createdAt > DRAFT_TTL_MS) pendingDrafts.delete(id);
   }
 }
 
 export default function registerSendTools(server: McpServer, smtpService: SmtpService): void {
   // ---------------------------------------------------------------------------
   // draft_email — prepares a send/reply/forward. NEVER sends anything.
   // ---------------------------------------------------------------------------
   server.tool(
     'draft_email',
     'Prepare a draft for a new email, a reply, or a forward. This tool NEVER sends anything, it only prepares and returns the draft content. Always call this tool first. Then show the FULL draft (recipients, subject, body) to the user in plain readable text in the chat, and wait for their explicit confirmation. Pay special attention to any sensitive content warning returned. Only after the user explicitly confirms should you call confirm_send_email with the returned draftId.',
     {
       type: z.enum(['send', 'reply', 'forward']).describe('Type of draft to prepare'),
       account: z.string().describe('Account name from list_accounts'),
       to: z.array(z.string().email()).optional().describe('Recipients (required for send/forward)'),
       subject: z.string().optional().describe('Subject (required for send)'),
       body: z.string().optional().describe('Body content'),
       cc: z.array(z.string().email()).optional().describe('CC recipients'),
       bcc: z.array(z.string().email()).optional().describe('BCC recipients (send only)'),
       html: z.boolean().default(false).describe('Send as HTML'),
       emailId: z.string().optional().describe('Original email ID (required for reply/forward)'),
       mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
       replyAll: z.boolean().default(false).describe('Reply to all recipients (reply only)'),
     },
     { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
     async (params) => {
       cleanExpiredDrafts();
       const draftId = randomUUID();
       const createdAt = Date.now();
 
       if (params.type === 'send') {
         if (!params.to || !params.subject || params.body === undefined) {
           return {
             isError: true,
             content: [{ type: 'text' as const, text: 'Missing to/subject/body for a send draft.' }],
           };
         }
         validateInputLength(params.subject, 998, 'Subject');
         validateInputLength(params.body, 5_000_000, 'Body');
         pendingDrafts.set(draftId, {
           kind: 'send',
           account: params.account,
           to: params.to,
           subject: params.subject,
           body: params.body,
           cc: params.cc,
           bcc: params.bcc,
           html: params.html,
           createdAt,
         });
         const { flags } = detectSensitiveContent(params.subject, params.body);
         const warning = formatSensitiveWarning(flags);
         return {
           content: [
             {
               type: 'text' as const,
               text: `DRAFT READY (not sent yet)\ndraftId: ${draftId}\n\nTo: ${params.to.join(', ')}\n${params.cc ? `Cc: ${params.cc.join(', ')}\n` : ''}Subject: ${params.subject}\n\n${params.body}${warning}\n\nShow this to the user (including any sensitive content warning above) and wait for explicit confirmation before calling confirm_send_email.`,
             },
           ],
         };
       }
 
       if (params.type === 'reply') {
         if (!params.emailId || params.body === undefined) {
           return {
             isError: true,
             content: [{ type: 'text' as const, text: 'Missing emailId/body for a reply draft.' }],
           };
         }
         pendingDrafts.set(draftId, {
           kind: 'reply',
           account: params.account,
           emailId: params.emailId,
           mailbox: params.mailbox,
           body: params.body,
           replyAll: params.replyAll,
           html: params.html,
           createdAt,
         });
         const { flags } = detectSensitiveContent('', params.body);
         const warning = formatSensitiveWarning(flags);
         return {
           content: [
             {
               type: 'text' as const,
               text: `DRAFT REPLY READY (not sent yet)\ndraftId: ${draftId}\n\nReplying to email: ${params.emailId}\nReply all: ${params.replyAll}\n\n${params.body}${warning}\n\nShow this to the user (including any sensitive content warning above) and wait for explicit confirmation before calling confirm_send_email.`,
             },
           ],
         };
       }
 
       // forward
       if (!params.to || !params.emailId) {
         return {
           isError: true,
           content: [{ type: 'text' as const, text: 'Missing to/emailId for a forward draft.' }],
         };
       }
       pendingDrafts.set(draftId, {
         kind: 'forward',
         account: params.account,
         emailId: params.emailId,
         mailbox: params.mailbox,
         to: params.to,
         body: params.body,
         cc: params.cc,
         createdAt,
       });
       const { flags } = detectSensitiveContent('', params.body ?? '');
       const warning = formatSensitiveWarning(flags);
       return {
         content: [
           {
             type: 'text' as const,
             text: `DRAFT FORWARD READY (not sent yet)\ndraftId: ${draftId}\n\nForwarding email: ${params.emailId}\nTo: ${params.to.join(', ')}\n${params.cc ? `Cc: ${params.cc.join(', ')}\n` : ''}${params.body ? `\nMessage: ${params.body}\n` : ''}${warning}\n\nShow this to the user (including any sensitive content warning above, and note that the ORIGINAL forwarded email content is not scanned) and wait for explicit confirmation before calling confirm_send_email.`,
           },
         ],
       };
     },
   );
 
   // ---------------------------------------------------------------------------
   // confirm_send_email — actually sends a previously prepared draft
   // ---------------------------------------------------------------------------
   server.tool(
     'confirm_send_email',
     'Actually sends a previously prepared draft, identified by draftId returned from draft_email. ONLY call this after the user has explicitly confirmed in the chat that they approve the exact content shown. Never call this tool speculatively or without a prior explicit user confirmation.',
     {
       draftId: z.string().describe('The draftId returned by draft_email'),
     },
     { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
     async ({ draftId }) => {
       cleanExpiredDrafts();
       const draft = pendingDrafts.get(draftId);
       if (!draft) {
         return {
           isError: true,
           content: [
             {
               type: 'text' as const,
               text: 'No pending draft found for this draftId. It may have expired (15 min) or already been sent. Call draft_email again.',
             },
           ],
         };
       }
       pendingDrafts.delete(draftId);
 
       try {
         if (draft.kind === 'send') {
           const result = await smtpService.sendEmail(draft.account, {
             to: draft.to,
             subject: draft.subject,
             body: draft.body,
             cc: draft.cc,
             bcc: draft.bcc,
             html: draft.html,
           });
           await audit.log('send_email', draft.account, { to: draft.to, subject: draft.subject }, 'ok');
           return {
             content: [
               {
                 type: 'text' as const,
                 text: `Email sent successfully!\nTo: ${draft.to.join(', ')}\nSubject: ${draft.subject}\nMessage-ID: ${result.messageId}`,
               },
             ],
           };
         }
 
         if (draft.kind === 'reply') {
           const result = await smtpService.replyToEmail(draft.account, {
             emailId: draft.emailId,
             mailbox: draft.mailbox,
             body: draft.body,
             replyAll: draft.replyAll,
             html: draft.html,
           });
           await audit.log(
             'reply_email',
             draft.account,
             { emailId: draft.emailId, mailbox: draft.mailbox },
             'ok',
           );
           return {
             content: [
               { type: 'text' as const, text: `Reply sent successfully!\nMessage-ID: ${result.messageId}` },
             ],
           };
         }
 
         // forward
         const result = await smtpService.forwardEmail(draft.account, {
           emailId: draft.emailId,
           mailbox: draft.mailbox,
           to: draft.to,
           body: draft.body,
           cc: draft.cc,
         });
         await audit.log('forward_email', draft.account, { to: draft.to, emailId: draft.emailId }, 'ok');
         return {
           content: [
             {
               type: 'text' as const,
               text: `Email forwarded successfully!\nTo: ${draft.to.join(', ')}\nMessage-ID: ${result.messageId}`,
             },
           ],
         };
       } catch (err) {
         const errMsg = err instanceof Error ? err.message : String(err);
         const action = draft.kind === 'send' ? 'send_email' : draft.kind === 'reply' ? 'reply_email' : 'forward_email';
         await audit.log(action, draft.account, {}, 'error', errMsg);
         return {
           isError: true,
           content: [{ type: 'text' as const, text: `Failed to send: ${errMsg}` }],
         };
       }
     },
   );
 }