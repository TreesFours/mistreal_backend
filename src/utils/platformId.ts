// Pulled out of socialService.ts into their own zero-dependency module —
// zernioAdapter.ts needs this same normalization (see sendAction's platform
// lookup) but socialService.ts already imports ZernioAdapter, so importing
// back from socialService.ts would be a circular import.
export const normalizePlatformId = (platform: string): string => {
    if (!platform) return '';
    const lower = platform.toLowerCase().trim();
    if (lower === 'x' || lower === 'twitter') return 'twitter';
    if (lower.startsWith('linkedin')) return 'linkedin';
    if (lower.startsWith('facebook')) return 'facebook';
    if (lower.startsWith('instagram')) return 'instagram';
    if (lower.startsWith('whatsapp')) return 'whatsapp';
    if (lower.startsWith('youtube')) return 'youtube';
    if (lower.startsWith('tiktok')) return 'tiktok';
    if (lower.startsWith('telegram')) return 'telegram';
    if (lower.startsWith('discord')) return 'discord';
    if (lower.startsWith('reddit')) return 'reddit';
    return lower;
};

export const isPlatformMatching = (platformA: string, platformB: string): boolean => {
    return normalizePlatformId(platformA) === normalizePlatformId(platformB);
};
