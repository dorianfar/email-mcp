/**
 * MCP tools: move_email, prepare_delete_email, confirm_delete_email, mark_email
 * Deletion is a two-step flow: the email must be shown and confirmed before it is actually deleted.
 */

 import { randomUUID } from 'node:crypto';
 import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
 import { z } from 'zod';
 import audit from '../safety/audit.js';
 import { sanitizeMailboxName } from '../safety/validation.js';
 
 import type ImapService from '../services/imap.service.js';
 
 interface PendingDeletion {
   account: string;
   emailId: string;
   mailbox: string;
   permanent: boolean;
   createdAt: number;
 }
 
 const pendingDeletions = new Map<string, PendingDeletion>();
 const DELETE_TTL_MS = 15 * 60 * 1000; // 15 minutes
 
 function cleanExpiredDeletions(): void {
   const now = Date.now();
   for (const [id, del] of pendingDeletions) {
     if (now - del.createdAt > DELETE_TTL_MS) pendingDeletions.delete(id);
   }
 }
 
 export default function registerManageTools(server: McpServer, imapService: ImapService): void {
   // ---------------------------------------------------------------------------
   // move_email
   // ---------------------------------------------------------------------------
   server.tool(
     'move_email',
     'Move an email to a different mailbox folder. ' +
       'The sourceMailbox must be a real folder, not a virtual one like "All Mail". ' +
       'Use find_email_folder first if the email was discovered in a virtual folder.',
     {
       account: z.string().describe('Account name from list_accounts'),
       emailId: z.string().describe('Email ID to move (from list_emails)'),
       sourceMailbox: z.string().describe('Current mailbox (e.g., INBOX)'),
       destinationMailbox: z
         .string()
         .describe('Target mailbox (e.g., Archive). Use list_mailboxes to see options.'),
     },
     { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
     async ({ account, emailId, sourceMailbox, destinationMailbox }) => {
       try {
         const cleanSource = sanitizeMailboxName(sourceMailbox);
         const cleanDest = sanitizeMailboxName(destinationMailbox);
         await imapService.moveEmail(account, emailId, cleanSource, cleanDest);
         await audit.log(
           'move_email',
           account,
           { emailId, sourceMailbox, destinationMailbox },
           'ok',
         );
         return {
           content: [
             {
               type: 'text' as const,
               text: `✅ Email moved from "${sourceMailbox}" to "${destinationMailbox}".`,
             },
           ],
         };
       } catch (err) {
         const errMsg = err instanceof Error ? err.message : String(err);
         await audit.log(
           'move_email',
           account,
           { emailId, sourceMailbox, destinationMailbox },
           'error',
           errMsg,
         );
         return {
           isError: true,
           content: [
             {
               type: 'text' as const,
               text: `Failed to move email: ${errMsg}`,
             },
           ],
         };
       }
     },
   );
 
   // ---------------------------------------------------------------------------
   // prepare_delete_email — shows what would be deleted. NEVER deletes anything.
   // ---------------------------------------------------------------------------
   server.tool(
     'prepare_delete_email',
     'Prepare a deletion request for an email. This tool NEVER deletes anything, it only returns the details of what would be deleted. Always call this tool first, use get_email to fetch and show the email subject/sender to the user in plain readable text, and wait for their explicit confirmation. Only after the user explicitly confirms should you call confirm_delete_email with the returned deleteId.',
     {
       account: z.string().describe('Account name from list_accounts'),
       emailId: z.string().describe('Email ID to delete (from list_emails)'),
       mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
       permanent: z.boolean().default(false).describe('⚠️ Permanently delete (skip Trash) — irreversible'),
     },
     { readOnlyHint: true, destructiveHint: false },
     async ({ account, emailId, mailbox, permanent }) => {
       cleanExpiredDeletions();
       const deleteId = randomUUID();
       pendingDeletions.set(deleteId, {
         account,
         emailId,
         mailbox,
         permanent,
         createdAt: Date.now(),
       });
       return {
         content: [
           {
             type: 'text' as const,
             text: `DELETION PENDING (nothing deleted yet)\ndeleteId: ${deleteId}\n\nEmail ID: ${emailId}\nMailbox: ${mailbox}\nMode: ${permanent ? '⚠️ PERMANENT (irreversible, skips Trash)' : 'Move to Trash (recoverable)'}\n\nShow the email's subject and sender to the user (use get_email if needed) and wait for explicit confirmation before calling confirm_delete_email.`,
           },
         ],
       };
     },
   );
 
   // ---------------------------------------------------------------------------
   // confirm_delete_email — actually deletes a previously prepared deletion
   // ---------------------------------------------------------------------------
   server.tool(
     'confirm_delete_email',
     'Actually deletes a previously prepared deletion, identified by deleteId from prepare_delete_email. ONLY call this after the user has explicitly confirmed in the chat that they approve deleting this specific email. Never call this tool speculatively or without prior explicit user confirmation.',
     {
       deleteId: z.string().describe('The deleteId returned by prepare_delete_email'),
     },
     { readOnlyHint: false, destructiveHint: true },
     async ({ deleteId }) => {
       cleanExpiredDeletions();
       const del = pendingDeletions.get(deleteId);
       if (!del) {
         return {
           isError: true,
           content: [
             {
               type: 'text' as const,
               text: 'No pending deletion found for this deleteId. It may have expired (15 min) or already been processed. Call prepare_delete_email again.',
             },
           ],
         };
       }
       pendingDeletions.delete(deleteId);
 
       try {
         const cleanMailbox = sanitizeMailboxName(del.mailbox);
         await imapService.deleteEmail(del.account, del.emailId, cleanMailbox, del.permanent);
         await audit.log(
           'delete_email',
           del.account,
           { emailId: del.emailId, mailbox: del.mailbox, permanent: del.permanent },
           'ok',
         );
         return {
           content: [
             {
               type: 'text' as const,
               text: del.permanent ? `⚠️ Email permanently deleted.` : `🗑️ Email moved to Trash.`,
             },
           ],
         };
       } catch (err) {
         const errMsg = err instanceof Error ? err.message : String(err);
         await audit.log(
           'delete_email',
           del.account,
           { emailId: del.emailId, mailbox: del.mailbox, permanent: del.permanent },
           'error',
           errMsg,
         );
         return {
           isError: true,
           content: [
             {
               type: 'text' as const,
               text: `Failed to delete email: ${errMsg}`,
             },
           ],
         };
       }
     },
   );
 
   // ---------------------------------------------------------------------------
   // mark_email
   // ---------------------------------------------------------------------------
   server.tool(
     'mark_email',
     'Change email flags — mark as read/unread, flag/unflag. Idempotent: marking an already-read email as read is a no-op.',
     {
       account: z.string().describe('Account name from list_accounts'),
       id: z.string().describe('Email ID (UID) from list_emails or search_emails'),
       mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
       action: z
         .enum(['read', 'unread', 'flag', 'unflag'])
         .describe('Action: read, unread, flag (star), or unflag (unstar)'),
     },
     { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
     async ({ account, id, mailbox, action }) => {
       try {
         await imapService.setFlags(account, id, mailbox, action);
         await audit.log('mark_email', account, { id, mailbox, action }, 'ok');
         const labels: Record<string, string> = {
           read: '📖 Marked as read',
           unread: '📩 Marked as unread',
           flag: '⭐ Flagged',
           unflag: '☆ Unflagged',
         };
         return {
           content: [{ type: 'text' as const, text: `${labels[action]}.` }],
         };
       } catch (err) {
         const errMsg = err instanceof Error ? err.message : String(err);
         await audit.log('mark_email', account, { id, mailbox, action }, 'error', errMsg);
         return {
           isError: true,
           content: [
             {
               type: 'text' as const,
               text: `Failed to mark email: ${errMsg}`,
             },
           ],
         };
       }
     },
   );
 }