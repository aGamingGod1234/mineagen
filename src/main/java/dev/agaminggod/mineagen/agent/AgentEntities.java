package dev.agaminggod.mineagen.agent;

import net.fabricmc.fabric.api.object.builder.v1.entity.FabricDefaultAttributeRegistry;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.MobCategory;

public final class AgentEntities {
	public static final Identifier CODEX_AGENT_ID = Identifier.fromNamespaceAndPath("mineagen", "codex_agent");
	public static final ResourceKey<EntityType<?>> CODEX_AGENT_KEY = ResourceKey.create(
			Registries.ENTITY_TYPE,
			CODEX_AGENT_ID
	);
	public static final EntityType<AgentEntity> CODEX_AGENT = Registry.register(
			BuiltInRegistries.ENTITY_TYPE,
			CODEX_AGENT_ID,
			EntityType.Builder.of(AgentEntity::new, MobCategory.CREATURE)
					.sized(0.6F, 1.8F)
					.clientTrackingRange(10)
					.updateInterval(2)
					.build(CODEX_AGENT_KEY)
	);
	private static boolean attributesRegistered;

	private AgentEntities() {
	}

	public static synchronized void register() {
		if (attributesRegistered) {
			return;
		}
		FabricDefaultAttributeRegistry.register(CODEX_AGENT, AgentEntity.createAttributes());
		attributesRegistered = true;
	}
}
