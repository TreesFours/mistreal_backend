import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2024-06-20',
});

// Real logic to create a dynamic Stripe payment link for tiers
export const createSubscriptionSession = async (tier: string) => {
    try {
        // Map tiers to your Stripe Price IDs (You create these in Stripe Dashboard)
        const priceMap: Record<string, string> = {
            'ai_plus': process.env.STRIPE_PRICE_AI_PLUS || 'price_placeholder_1',
            'social_plus': process.env.STRIPE_PRICE_SOCIAL_PLUS || 'price_placeholder_2',
            'elite': process.env.STRIPE_PRICE_ELITE || 'price_placeholder_3'
        };

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceMap[tier],
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: 'https://mistreal-assistant.com/success',
            cancel_url: 'https://mistreal-assistant.com/cancel',
        });

        return session.url;
    } catch (error: any) {
        console.error('Stripe Session Error:', error.message);
        throw error;
    }
};

export const handleWebhook = async (payload: any, sig: string) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
        console.warn("Stripe Webhook Secret not set. Skipping verification.");
        return;
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(payload, sig, webhookSecret);
    } catch (err: any) {
        throw new Error(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        // Logic to update user status to "PRO" in your database/Redis
        console.log(`💰 PROFIT ALERT: User subscribed via Stripe! Customer: ${session.customer}`);
    }
};
