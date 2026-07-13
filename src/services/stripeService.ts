import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2024-06-20',
});

export const createSubscriptionSession = async (customerId: string, priceId: string) => {
    try {
        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: 'https://your-app.com/success?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: 'https://your-app.com/cancel',
        });

        return session.url;
    } catch (error: any) {
        console.error('Stripe Session Error:', error.message);
        throw error;
    }
};

export const handleWebhook = async (payload: any, sig: string) => {
    let event;
    try {
        event = stripe.webhooks.constructEvent(
            payload,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET!
        );
    } catch (err: any) {
        throw new Error(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object as Stripe.Checkout.Session;
            // Update user subscription status in Redis/Database
            console.log(`Payment successful for ${session.customer}`);
            break;
        default:
            console.log(`Unhandled event type ${event.type}`);
    }
};
