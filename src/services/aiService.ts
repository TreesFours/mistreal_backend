import axios from 'axios';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const getAiResponse = async (prompt: string, provider: string, history: any[], user?: any) => {
    const apiKey = process.env.OPENROUTER_API_KEY;

    // Flexible mapping for providers
    const providerLower = provider.toLowerCase();
    const model = providerLower.includes('gpt4') ? 'openai/gpt-4-turbo' :
                  providerLower.includes('claude') ? 'anthropic/claude-3.5-sonnet' :
                  providerLower.includes('gemini') ? 'google/gemini-pro-1.5' :
                  'google/gemini-pro-1.5'; // Default fallback

    console.log(`🤖 AI Request: Provider=${provider}, MappedModel=${model}`);

    try {
        const response = await axios.post(
            OPENROUTER_API_URL,
            {
                model: model,
                messages: [
                    ...history,
                    { role: 'user', content: prompt }
                ]
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'HTTP-Referer': 'https://mistreal-assistant.com', // Optional
                    'X-Title': 'Mistreal Assistant'
                }
            }
        );

        return {
            content: response.data.choices[0].message.content,
            provider: provider,
            success: true
        };
    } catch (error: any) {
        console.error('AI Service Error:', error.response?.data || error.message);
        return {
            content: '',
            provider: provider,
            success: false,
            error: error.response?.data?.error?.message || 'AI request failed'
        };
    }
};
