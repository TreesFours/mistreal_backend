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
    imageMimeTypes?: string[]; // parallel to imageDatas — real per-attachment mime type; falls back to 'image/jpeg' when absent
    audioData?: string;
}

export interface GroundingCitation {
    uri: string;
    title?: string;
}

export interface ProviderChatResponse {
    content: string;
    modelUsed: string;
    success: boolean;
    error?: string;
    // Only ever populated by GeminiProvider, when google_search_retrieval
    // grounded the answer — the tool was already being paid for on every
    // Gemini request, but its citation output was previously discarded.
    groundingCitations?: GroundingCitation[];
}

export interface AiProvider {
    id: string;
    chat(req: ProviderChatRequest): Promise<ProviderChatResponse>;
}
