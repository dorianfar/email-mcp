/**
 * Fetches and decrypts email account credentials from Supabase for multi-tenant mode.
 * Uses the service_role key (server-side only, never exposed to clients).
 */

import { createClient } from '@supabase/supabase-js';
import { decryptSecret } from '../safety/credential-crypto.js';
import type { AccountConfig } from '../types/index.js';

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable is missing.');
  }
  return createClient(url, serviceKey);
}

/**
 * Looks up a user's email account(s) by their API key (a per-account secret,
 * distinct from their Supabase login password).
 * Returns the account(s) formatted for use by the existing ConnectionManager.
 */
export async function getAccountsByApiKey(apiKey: string): Promise<AccountConfig[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('api_key', apiKey);

  if (error) {
    throw new Error(`Failed to fetch account from Supabase: ${error.message}`);
  }
  if (!data || data.length === 0) {
    throw new Error('No account found for this API key.');
  }

  return data.map((row) => ({
    name: row.account_name,
    email: row.email_address,
    username: row.email_address,
    password: decryptSecret(row.encrypted_password),
    fullName: undefined,
    imap: {
      host: row.imap_host,
      port: row.imap_port,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: row.smtp_host,
      port: row.smtp_port,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
  }));
}