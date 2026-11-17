package dev.agaminggod.mineagen.server.conversation;

public interface AgentConversationRouter {
	DeliveryReceipt deliver(ConversationEvent event);
}
