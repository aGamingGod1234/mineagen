package dev.agaminggod.mineagen.client.render;

import dev.agaminggod.mineagen.agent.AgentVisualIdentity;
import dev.agaminggod.mineagen.agent.AgentEntity;
import net.minecraft.client.model.HumanoidModel;
import net.minecraft.client.model.geom.ModelLayers;
import net.minecraft.client.renderer.entity.EntityRendererProvider;
import net.minecraft.client.renderer.entity.HumanoidMobRenderer;
import net.minecraft.resources.Identifier;

public final class AgentRenderer extends HumanoidMobRenderer<
		AgentEntity,
		AgentRenderState,
		HumanoidModel<AgentRenderState>
> {
	private static final float SHADOW_RADIUS = 0.5F;

	public AgentRenderer(EntityRendererProvider.Context context) {
		super(context, new HumanoidModel<>(context.bakeLayer(ModelLayers.ZOMBIE)), SHADOW_RADIUS);
	}

	@Override
	public AgentRenderState createRenderState() {
		return new AgentRenderState();
	}

	@Override
	public void extractRenderState(AgentEntity entity, AgentRenderState state, float partialTick) {
		super.extractRenderState(entity, state, partialTick);
		state.setProvider(entity.getProvider());
		state.setModel(entity.getModelName());
		state.setSkinVariant(entity.getSkinVariant());
	}

	@Override
	public Identifier getTextureLocation(AgentRenderState state) {
		return textureFor(AgentVisualIdentity.resolve(state.provider(), state.model(), state.skinVariant()));
	}

	public static Identifier textureFor(AgentVisualIdentity.Resolved identity) {
		return Identifier.parse(AgentVisualIdentity.renderTexturePath(identity));
	}
}
