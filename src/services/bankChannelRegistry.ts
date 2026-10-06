/**
 * Curated directory of banks' official WhatsApp/Facebook chat channels.
 *
 * There is no API or dataset for this — verified manually per bank, starting
 * with Nigeria (the only country with confirmed examples so far). Expand this
 * list over time rather than guessing a channel exists; `whatsapp`/`facebook`
 * are both optional and independent since real banks vary (e.g. Access Bank
 * currently has no WhatsApp banking channel at all).
 *
 * This only ever points the user at a bank's own official chat — nothing
 * here collects, stores, or transmits any banking credential or payment
 * instruction. Any "payment through chat" happens entirely inside WhatsApp/
 * Facebook and the bank's own systems, outside this app.
 */
export interface BankChannelDefinition {
    id: string;
    displayName: string;
    country: string; // ISO 3166-1 alpha-2
    whatsapp?: { number: string; prefilledMessage?: string };
    facebook?: { pageId: string };
}

export const BANK_CHANNELS: BankChannelDefinition[] = [
    {
        id: 'zenith_ng',
        displayName: 'Zenith Bank',
        country: 'NG',
        whatsapp: { number: '2347040004422', prefilledMessage: 'Hi ZiVA, I need help with my account.' }
    },
    {
        id: 'uba_ng',
        displayName: 'United Bank for Africa (UBA)',
        country: 'NG',
        whatsapp: { number: '2347007822000', prefilledMessage: 'Hi Leo, I need help with my account.' },
        facebook: { pageId: 'UBAGroup' }
    },
    {
        id: 'firstbank_ng',
        displayName: 'First Bank of Nigeria',
        country: 'NG',
        whatsapp: { number: '2348124444000' }
    },
    {
        id: 'gtbank_ng',
        displayName: 'Guaranty Trust Bank (GTBank)',
        country: 'NG',
        whatsapp: { number: '2347002255739' }
    },
    {
        id: 'access_ng',
        displayName: 'Access Bank',
        country: 'NG'
        // No confirmed WhatsApp/Facebook chat channel as of this writing —
        // intentionally left without either field rather than guessing.
    }
];

export const getBankChannels = (countryCode?: string): BankChannelDefinition[] => {
    if (!countryCode) return BANK_CHANNELS;
    const matches = BANK_CHANNELS.filter(b => b.country === countryCode.toUpperCase());
    // "World" fallback: no banks on file for this country yet, so show
    // everything curated so far rather than an empty, dead-end list.
    return matches.length > 0 ? matches : BANK_CHANNELS;
};
