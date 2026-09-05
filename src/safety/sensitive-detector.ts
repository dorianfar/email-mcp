/**
 * Detects potentially sensitive content in outgoing emails
 * (financial info, personal identifiers, passwords) to trigger extra warnings
 * before sending. This is a best-effort keyword/pattern check, not a guarantee.
 */

 interface SensitiveCheckResult {
    hasSensitive: boolean;
    flags: string[];
  }
  
  const KEYWORD_PATTERNS: Array<{ label: string; regex: RegExp }> = [
    { label: 'IBAN / RIB', regex: /\b(iban|rib|bic|swift)\b/i },
    { label: 'IBAN (format)', regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/ },
    { label: 'Virement / paiement', regex: /\b(virement|paiement|transfert d'argent)\b/i },
    { label: 'Carte bancaire', regex: /\b(carte bancaire|cvv|cvc|numéro de carte)\b/i },
    { label: 'Mot de passe / code secret', regex: /\b(mot de passe|password|code secret|code confidentiel)\b/i },
    { label: 'Numéro de sécurité sociale', regex: /\b(numéro de sécurité sociale|n° sécu|num[ée]ro fiscal)\b/i },
    { label: 'Montant en euros', regex: /\b\d[\d\s]*(?:[.,]\d{2})?\s?€|\b\d[\d\s]*(?:[.,]\d{2})?\s?(eur|euros)\b/i },
  ];
  
  export function detectSensitiveContent(subject: string, body: string): SensitiveCheckResult {
    const combined = `${subject}\n${body}`;
    const flags: string[] = [];
  
    for (const { label, regex } of KEYWORD_PATTERNS) {
      if (regex.test(combined)) {
        flags.push(label);
      }
    }
  
    return {
      hasSensitive: flags.length > 0,
      flags,
    };
  }
  
  export function formatSensitiveWarning(flags: string[]): string {
    if (flags.length === 0) return '';
    return `\n\n⚠️ ATTENTION — Contenu potentiellement sensible détecté : ${flags.join(', ')}.\nVérifiez attentivement le destinataire et le contenu avant de confirmer l'envoi.\n`;
  }