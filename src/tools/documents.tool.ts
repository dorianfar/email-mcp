/**
 * MCP tools: find_document, get_document_file
 * Lets the assistant search a user's stored documents (devis, factures,
 * contrats) and retrieve one to attach to an email.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type DocumentsService from '../services/documents.service.js';

export default function registerDocumentTools(
  server: McpServer,
  documentsService: DocumentsService,
): void {
  server.tool(
    'find_document',
    "Search the user's stored documents (devis, factures, contrats) by client name. Use this before attaching a document to an email. If several results match, show them to the user and ask which one they mean before proceeding.",
    {
      query: z.string().describe('Client name (or part of it) to search for'),
      documentType: z
        .enum(['devis', 'facture', 'contrat'])
        .optional()
        .describe('Restrict to this document type, if known'),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async ({ query, documentType }) => {
      try {
        const matches = await documentsService.search(query, documentType);
        if (matches.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No document found matching "${query}". Ask the user to check the client name or confirm the document has been uploaded.`,
              },
            ],
          };
        }
        const list = matches
          .map(
            (m) =>
              `- documentId: ${m.id} | ${m.documentType} | client: ${m.clientName} | file: ${m.originalFilename} | added: ${m.createdAt}`,
          )
          .join('\n');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${matches.length} matching document(s):\n${list}\n\nIf more than one result, ask the user to confirm which one before using get_document_file.`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to search documents: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    'get_document_file',
    'Retrieve the actual file content (base64) of a document found via find_document, identified by its documentId. Use this content to attach the file to a draft_email.',
    {
      documentId: z.string().describe('The documentId returned by find_document'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ documentId }) => {
      try {
        const file = await documentsService.getFile(documentId);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ filename: file.filename, mimeType: file.mimeType }, null, 2),
            },
            {
              type: 'text' as const,
              text: `\n--- Base64 Content ---\n${file.contentBase64}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to retrieve document: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
