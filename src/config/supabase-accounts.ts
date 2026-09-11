/**
 * Fetches and decrypts email account credentials from Supabase for multi-tenant mode.
 * Uses the service_role key (server-side only, never exposed to clients).
 */

import { createClient } from '@supabase/supabase-js';
import { decryptSecret } from '../safety/credential-crypto.js';
import type { AccountConfig, OAuth2Config } from '../types/index.js';

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable is missing.');
  }
  return createClient(url, serviceKey);
}

/**
 * Builds the OAuth2 config for a row whose oauth_provider is set.
 * client_id/client_secret are shared app-wide (one Azure/Google app for all
 * users) and come from environment variables; only the refresh token is
 * per-account, stored encrypted in Supabase.
 */
function buildOAuth2Config(provider: string, encryptedRefreshToken: string): OAuth2Config {
  if (provider === 'microsoft') {
    const clientId = process.env.MICROSOFT_CLIENT_ID;
    const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        'MICROSOFT_CLIENT_ID or MICROSOFT_CLIENT_SECRET environment variable is missing.',
      );
    }
    return {
      provider: 'microsoft',
      clientId,
      clientSecret,
      refreshToken: decryptSecret(encryptedRefreshToken),
    };
  }

  throw new Error(`Unsupported OAuth2 provider: ${provider}`);
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
    fullName: undefined,
    ...(row.oauth_provider
      ? { oauth2: buildOAuth2Config(row.oauth_provider, row.oauth_refresh_token_encrypted) }
      : { password: decryptSecret(row.encrypted_password) }),
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
      // Port 465 = implicit TLS; port 587 (used by Outlook/Microsoft 365) needs STARTTLS instead.
      tls: row.smtp_port === 465,
      starttls: row.smtp_port !== 465,
      verifySsl: true,
    },
  }));
}