import axios from 'axios';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const getAiResponse = async (prompt: string, provider: string, history: any[], user?: any) => {
    const apiKey = process.env.OPENROUTER_API_KEY;

    // Flexible mapping for providers
    const providerLower = (provider || 'gemini').toLowerCase();

    // Explicitly mapping common variants to guaranteed OpenRouter endpoints
    let model = 'google/gemini-flash-1.5'; // Default safe fallback

    if (providerLower.includes('gpt4')) {
        model = 'openai/gpt-4-turbo';
    } else if (providerLower.includes('claude')) {
        model = 'anthropic/claude-3.5-sonnet';
    } else if (providerLower.includes('gemini')) {
        model = 'google/gemini-pro-1.5';
    }

    console.log(`🤖 AI Request Received:`);
    console.log(`   - Raw Provider: ${provider}`);
    console.log(`   - Mapped Model: ${model}`);

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
                    'HTTP-Referer': 'https://mistreal-assistant.com',
                    'X-Title': 'Mistreal Assistant'
                }
            }
        );

        if (!response.data || !response.data.choices || response.data.choices.length === 0) {
            throw new Error('OpenRouter returned an empty response');
        }

        return {
            content: response.data.choices[0].message.content,
            provider: provider,
            success: true
        };
    } catch (error: any) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        console.error('❌ AI Service Error:', errorMessage);
        if (error.response?.data) {
            console.error('   - Full Error Context:', JSON.stringify(error.response.data));
        }

        return {
            content: '',
            provider: provider,
            success: false,
            error: errorMessage || 'AI request failed'
        };
    }
};
