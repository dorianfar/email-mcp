/**
 * Documents service — search and retrieve a user's stored devis/factures/contrats
 * for attaching to emails. Backed by Supabase (table `documents` + storage bucket `documents`).
 */

import { createClient } from '@supabase/supabase-js';

export interface DocumentMatch {
  id: string;
  clientName: string;
  documentType: string;
  originalFilename: string;
  createdAt: string;
}

export interface DocumentFile {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable is missing.');
  }
  return createClient(url, serviceKey);
}

function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'doc':
      return 'application/msword';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

export default class DocumentsService {
  constructor(private userId: string) {}

  /** Search this user's documents by client name (partial match) and optional type. */
  async search(query: string, documentType?: string): Promise<DocumentMatch[]> {
    const supabase = getSupabaseClient();
    let request = supabase
      .from('documents')
      .select('id, client_name, document_type, original_filename, created_at')
      .eq('user_id', this.userId)
      .ilike('client_name', `%${query}%`)
      .order('created_at', { ascending: false })
      .limit(10);

    if (documentType) {
      request = request.eq('document_type', documentType);
    }

    const { data, error } = await request;
    if (error) {
      throw new Error(`Failed to search documents: ${error.message}`);
    }

    return (data ?? []).map((row) => ({
      id: row.id as string,
      clientName: row.client_name as string,
      documentType: row.document_type as string,
      originalFilename: row.original_filename as string,
      createdAt: row.created_at as string,
    }));
  }

  /** Fetch a document's file content by id, verifying it belongs to this user. */
  async getFile(documentId: string): Promise<DocumentFile> {
    const supabase = getSupabaseClient();
    const { data: row, error: rowError } = await supabase
      .from('documents')
      .select('file_path, original_filename')
      .eq('id', documentId)
      .eq('user_id', this.userId)
      .single();

    if (rowError || !row) {
      throw new Error('Document not found (or does not belong to this account).');
    }

    const { data: fileData, error: downloadError } = await supabase.storage
      .from('documents')
      .download(row.file_path as string);

    if (downloadError || !fileData) {
      throw new Error(`Failed to download file: ${downloadError?.message ?? 'unknown error'}`);
    }

    const arrayBuffer = await fileData.arrayBuffer();
    const contentBase64 = Buffer.from(arrayBuffer).toString('base64');

    return {
      filename: row.original_filename as string,
      mimeType: guessMimeType(row.original_filename as string),
      contentBase64,
    };
  }
}
