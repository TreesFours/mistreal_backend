export interface ProviderChatMessage {
    role: string;
    content: string;
}

export interface ProviderChatRequest {
    systemInstruction: string;
    history: ProviderChatMessage[];
    prompt: string;
    apiKey: string;
    modelId?: string;        // single target model (BYOK: the user's chosen model)
    modelCandidates?: string[]; // ordered failover list (curated/app-key path only)
    baseUrl?: string;        // BYOK-only: custom OpenAI-compatible endpoint
    imageDatas?: string[];
    audioData?: string;
}

export interface ProviderChatResponse {
    content: string;
    modelUsed: string;
    success: boolean;
    error?: string;
}

export interface AiProvider {
    id: string;
    chat(req: ProviderChatRequest): Promise<ProviderChatResponse>;
}
