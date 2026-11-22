package dev.agaminggod.mineagen.server.runtime.reflex;

import dev.agaminggod.mineagen.compat.McCompat;

import dev.agaminggod.mineagen.server.runtime.ArmSwing;
import carpet.script.utils.Tracer;
import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.server.perception.LavaSpread;
import dev.agaminggod.mineagen.server.perception.ObservationVisibility;
import dev.agaminggod.mineagen.server.perception.ThreatDamage;
import dev.agaminggod.mineagen.server.perception.ThreatPerception;
import dev.agaminggod.mineagen.server.perception.WaterAirFacts;
import dev.agaminggod.mineagen.server.runtime.controller.CombatPlanning;
import dev.agaminggod.mineagen.server.runtime.controller.HazardExits;
import dev.agaminggod.mineagen.server.runtime.controller.HotbarWeapons;
import dev.agaminggod.mineagen.server.runtime.controller.SafeStep;
import dev.agaminggod.mineagen.server.runtime.controller.ServerNavigationController;
import dev.agaminggod.mineagen.server.runtime.controller.SwimPlanning;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputState;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputStates;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import net.minecraft.world.entity.boss.enderdragon.EnderDragonPart;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.SpawnerBlockEntity;
import dev.agaminggod.mineagen.server.runtime.AdvancedInteractionService;
import dev.agaminggod.mineagen.server.runtime.InventoryRoom;
import dev.agaminggod.mineagen.server.runtime.menu.AgentInventoryView;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.level.block.EntityBlock;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.shapes.BooleanOp;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.entity.item.FallingBlockEntity;

/**
 * What a firing does with the body, one tick at a time, through the same input a player has: eased turning, held keys,
 * the hotbar, and a swing only when the crosshair is on the target and the attack has recharged. A new action adds a
 * case to {@link #create} and registers its parameters in {@link ReflexSpec}.
 */
final class ReflexActions {
	private ReflexActions() {
	}

	/**
	 * {@code point} is the place the condition is about (an edge, lava) when it names no entity. {@code below} is the input
	 * of the agent's own action when it keeps running under a held action (null when it is paused); {@code fightShields}
	 * says the agent's fight holds the shield itself between swings.
	 */
	record Context(ServerPlayer player, Entity focus, boolean stance, ReflexSensors.Memory memory, Vec3 point,
			AgentInputState below, boolean fightShields) {
		Context(ServerPlayer player, Entity focus, boolean stance, ReflexSensors.Memory memory) {
			this(player, focus, stance, memory, null);
		}

		Context(ServerPlayer player, Entity focus, boolean stance, ReflexSensors.Memory memory, Vec3 point) {
			this(player, focus, stance, memory, point, null, false);
		}

		/** Where the threat is: the live focus entity, else the condition's point, else null. */
		Vec3 threat() {
			if (focus != null && focus.isAlive()) return focus.position();
			return point;
		}
	}

	record Step(ReflexScheduler.ActionStatus status, String detail) {
		static Step running(String detail) { return new Step(ReflexScheduler.ActionStatus.RUNNING, detail); }
		static Step done(String detail) { return new Step(ReflexScheduler.ActionStatus.DONE, detail); }
		static Step failed(String detail) { return new Step(ReflexScheduler.ActionStatus.FAILED, detail); }
	}

	interface Behaviour {
		/** Applies this tick's input through {@code input} (at most once) and reports the action's status. */
		Step tick(Context context, Consumer<AgentInputState> input);

		/** A held action (a raised shield) ends when its condition clears, for triggers too. */
		default boolean holdsWhileTrue() { return false; }

		/** The hotbar choice outlives the firing (a tool swap), instead of returning to the paused action's slot. */
		default boolean keepsSelection() { return false; }

		/** The firing ended (done, preempted, timed out): undo what must not outlive it, such as an open screen. */
		default void end(ServerPlayer player) { }
		/** Ticks a held action stays held after its condition clears. */
		default long releaseGraceTicks() { return 0L; }

		/** The agent's own moving action keeps running under this one, its movement keys passed through. */
		default boolean passesMovement() { return false; }

		/** Its goal is met and it only holds on (a burn running out): reaching the rule's maxS is done, not a timeout. */
		default boolean settled() { return false; }

		/** Under the agent's fight with an offhand shield, the fight raises the shield itself this tick (see Shield). */
		default boolean defersToFight() { return true; }

		/** Only holds on now in a way the agent's paused fight handles itself (out of a fire block, still burning). */
		default boolean yieldsToFight() { return false; }

		/** Answers shots with a held shield itself this firing, so a shield rule for shots need not take the body. */
		default boolean blocksShots() { return false; }

		/**
		 * Moves the body through controllers with their own navigation leases, never through the reflex input: a reflex
		 * lease kept from the firing before it would outrank them and hold the body still.
		 */
		default boolean drivesOwnNavigation() { return false; }
	}

	static Behaviour create(ReflexSpec.Action action) {
		return switch (action.type()) {
			case "shield" -> new Shield(action.flag("counter"));
			case "attack" -> new Attack();
			case "step_back" -> new StepBack(action.number("blocks", 2.0D));
			case "eat" -> new Eat();
			case "select" -> new Select(action.text("tool"), action.text("item"));
			case "swim_up" -> new SwimUp();
			case "pickup" -> new Pickup(action.number("within", 4.0D));
			case "collect_drops" -> new CollectDrops();
			case "place" -> new Place(action.text("item"), action.text("where"));
			case "stop" -> new Stop();
			case "deflect" -> new Deflect();
			case "sprint_away" -> new SprintAway(action.number("blocks", 8.0D));
			case "move_to_cell" -> new MoveToCell(new GridPosition(Mth.floor(action.number("x", 0.0D)), Mth.floor(action.number("y", 0.0D)),
					Mth.floor(action.number("z", 0.0D))), action.flag("sprint"));
			case "sneak" -> new Sneak();
			case "look_away" -> new LookAway();
			case "place_block" -> new PlaceBlock(action.text("item"), (int) action.number("count", 2.0D));
			case "take_cover" -> new TakeCover((int) action.number("within", 6.0D), true);
			case "away_from_edge" -> new AwayFromEdge(action.number("blocks", 6.0D));
			case "dig_out" -> new DigOut();
			case "defend" -> new Defend();
			case "leave_fire", "leave_lava" -> new LeaveFire();
			// Never started: the engine treats a brace rule as a body setting (see ReflexEngine), not a firing.
			case "brace" -> (context, input) -> Step.done("brace never takes the body");
			default -> (context, input) -> Step.failed("unknown action " + action.type());
		};
	}

	static String lacks(ServerPlayer player, ReflexSpec.Action action) {
		return lacks(player, action, false);
	}

	/** As above; for the coordinator's default eat rule, also {@link #topUpLacks}. */
	static String lacks(ServerPlayer player, ReflexSpec.Action action, boolean coordinatorDefault) {
		String lacks = lacks(action, index -> Held.of(player.getInventory().getItem(index)), player.getInventory().getSelectedSlot(), Held.of(player.getOffhandItem()));
		if (lacks != null || !topUpApplies(action, coordinatorDefault)) return lacks;
		return topUpLacks(index -> Held.of(player.getInventory().getItem(index)), Held.of(player.getOffhandItem()), player.getFoodData().getFoodLevel(), player.getHealth());
	}

	/**
	 * The coordinator's default eat rule tops up below 18 with or without the instincts arm (practice room: a hurt body at
	 * hunger 16 with bread healed 12 to 20 in 10 of 10 runs at 18, and stayed at 12 in 10 of 10 at the old 14), so the
	 * top-up food choice applies to it in both arms. A rule the model writes eats what it says.
	 */
	static boolean topUpApplies(ReflexSpec.Action action, boolean coordinatorDefault) {
		return coordinatorDefault && "eat".equals(action.type());
	}

	/** At this hunger or more, eating only tops the bar up toward 18 for healing (issue 2 Step 2). */
	static final int TOP_UP_HUNGER = 14;

	/**
	 * The default eat rule eats from hunger 17 to heal (health regrows only at 18+). Topping up is not worth a harmful food
	 * (rotten flesh, raw chicken) or a golden apple above {@link Eat#HEALING_FOOD_HEALTH}, so at {@link #TOP_UP_HUNGER} or more
	 * with only those in reach the default eat rule sleeps and says why, instead of eating them or failing each cooldown.
	 */
	static String topUpLacks(java.util.function.IntFunction<Held> slots, Held offhand, int foodLevel, float health) {
		if (foodLevel < TOP_UP_HUNGER) return null;
		return holds(slots, offhand, 9, held -> held.food() && !Eat.LAST_RESORT_FOODS.contains(held.id())
				&& (!Eat.HEALING_FOODS.contains(held.id()) || health <= Eat.HEALING_FOOD_HEALTH)) ? null
				: "only last-resort food in hotbar or offhand while hunger is " + TOP_UP_HUNGER + "+";
	}

	/** One inventory slot as {@link #lacks} reads it: the item id (null when empty), and whether it is food or a cover block. */
	record Held(String id, boolean food, boolean coverBlock) {
		static final Held EMPTY = new Held(null, false, false);

		static Held of(ItemStack stack) {
			return stack.isEmpty() ? EMPTY : new Held(ReflexActions.id(stack), stack.get(DataComponents.FOOD) != null, PlaceBlock.coverBlock(stack));
		}
	}

	/**
	 * {@link #lacks(ServerPlayer, ReflexSpec.Action)} over inventory slots 0..35 (0..8 the hotbar), the selected hotbar
	 * slot and the offhand.
	 */
	static String lacks(ReflexSpec.Action action, java.util.function.IntFunction<Held> slots, int selected, Held offhand) {
		String item = action.text("item");
		return switch (action.type()) {
			case "place" -> holds(slots, offhand, 9, held -> item.equals(held.id())) ? null : "no " + item + " in hotbar or offhand";
			// The stance raises the shield it holds; it does not switch to one.
			case "shield" -> "minecraft:shield".equals(offhand.id()) || "minecraft:shield".equals(slots.apply(selected).id()) ? null : "no shield in either hand";
			case "eat" -> holds(slots, offhand, 9, Held::food) ? null : "no food in hotbar or offhand";
			case "place_block" -> holds(slots, Held.EMPTY, 9, held -> item != null ? item.equals(held.id()) : held.coverBlock()) ? null
					: "no " + (item != null ? item : "full block") + " in hotbar";
			case "select" -> item == null || holds(slots, offhand, 36, held -> item.equals(held.id())) ? null : "no " + item + " in inventory";
			default -> null;
		};
	}

	private static boolean holds(java.util.function.IntFunction<Held> slots, Held offhand, int count, java.util.function.Predicate<Held> wanted) {
		if (offhand.id() != null && wanted.test(offhand)) return true;
		for (int index = 0; index < count; index++) {
			Held held = slots.apply(index);
			if (held != null && held.id() != null && wanted.test(held)) return true;
		}
		return false;
	}

	/** Actions that stand and fight: a player stops them to breathe when the air runs short under water. */
	static boolean yieldsToBreath(ReflexSpec.Action action) {
		return "attack".equals(action.type());
	}

	private static AgentInputState look(ServerPlayer player, Vec3 target, float forward, float strafe, boolean jump,
			boolean use, int slot, InteractionHand hand) {
		float yaw = player.getYRot();
		float pitch = player.getXRot();
		if (target != null) {
			Vec3 delta = target.subtract(player.getEyePosition());
			double horizontal = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
			yaw = AgentInputStates.turnYaw(yaw, Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-delta.x, delta.z))));
			pitch = AgentInputStates.turnPitch(pitch, Mth.clamp((float) -Math.toDegrees(Math.atan2(delta.y, horizontal)), -90.0F, 90.0F));
		}
		return new AgentInputState(forward, strafe, jump, false, false, false, use, yaw, pitch, slot, hand);
	}

	static final long SHIELD_GRACE_TICKS = 10L;
	/** How far ahead a held shield turns to an incoming shot (the incoming_projectile default; a 180 degree turn takes ~5 ticks). */
	static final double SHIELD_SHOT_SECONDS = 1.0D;
	/** How long the shield stays toward where the last shot came from: a blaze volley is three shots over about a second. */
	static final long SHIELD_SHOT_HOLD_TICKS = 30L;

	/** How near a hostile mob must be for a raised shield to guard against it (a zombie hits from about 2 blocks). */
	static final double GUARD_RANGE = 3.5D;
	/** Widest spread of attackers, either side of the shield's facing, that one facing still covers (vanilla blocks to 90). */
	static final double GUARD_SPREAD_DEGREES = 75.0D;
	/** A melee mob's swing is followed by vanilla's 20-tick attack cooldown; a counter needs this many of them left. */
	static final long RECOVERY_TICKS = 20L;
	static final long COUNTER_WINDOW_TICKS = 8L;
	/** Ticks a counter may wait with the shield lowered for the swing to land before it raises the shield again. */
	static final int COUNTER_LOWERED_TICKS = 3;

	static final class Shield implements Behaviour {
		private final boolean counter;
		private int lastDamage = -1;
		private int blocked;
		private int countered;
		private InteractionHand hand;
		private Vec3 shotFrom;
		private long shotTick;
		private boolean defers = true;
		private int lowered;
		private final Map<Integer, Long> swungAt = new java.util.HashMap<>();

		@Override
		public void end(ServerPlayer player) {
			dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.keepLevel(player, this, false);
		}

		Shield() {
			this(false);
		}

		Shield(boolean counter) {
			this.counter = counter;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.keepLevel(player, this,
					context.below() == null && context.focus() instanceof net.minecraft.world.entity.monster.Blaze);
			InteractionHand current = player.getOffhandItem().is(Items.SHIELD) ? InteractionHand.OFF_HAND
					: player.getMainHandItem().is(Items.SHIELD) ? InteractionHand.MAIN_HAND : null;
			if (current == null) {
				// A player knows its shield just broke, and that only distance or cover helps now.
				String lost = hand != null ? "the shield broke after " + blocked + " blocked hit(s): " : "";
				return Step.failed(lost + "no shield in either hand; arm sprint_away or take_cover for this condition instead");
			}
			ItemStack shield = player.getItemInHand(current);
			// Each block wears the shield once (by a damage-scaled amount): count the wear events, not the points.
			if (hand == current && lastDamage >= 0 && shield.getDamageValue() > lastDamage) blocked++;
			hand = current;
			lastDamage = shield.getDamageValue();
			String held = (blocked == 0 ? "shield raised" : "blocked " + blocked + " hit(s)") + (countered > 0 ? ", countered " + countered : "");
			long now = player.level().getGameTime();
			// A player holding a shield turns it to the shot about to land, not to whichever mob is nearest.
			Entity shot = ReflexSensors.incomingShot(player, SHIELD_SHOT_SECONDS);
			// In flight it faces where the shot will touch the body (vanilla's block test); after, back along its line,
			// toward the shooter, so the next draw stays in view.
			Vec3 meet = shot == null ? null : ReflexSensors.strikeFacing(player, shot);
			if (shot != null) {
				shotFrom = ReflexSensors.aimPoint(shot);
				shotTick = now;
			}
			// Between the shots of a volley it stays toward where they come from.
			boolean volley = shotFrom != null && now - shotTick <= SHIELD_SHOT_HOLD_TICKS;
			defers = context.fightShields() && shot == null;
			if (defers) return Step.running(held + " (fight)");
			List<Mob> close = attackers(player);
			for (Mob mob : close) if (swingJustStarted(mob)) swungAt.put(mob.getId(), now);
			AgentInputState below = context.below();
			if (counter && !volley && below == null) {
				Step strike = counter(player, context.focus(), close, now, input);
				if (strike != null) return strike;
			}
			Vec3 target = meet != null ? meet : volley ? shotFrom : guardPoint(player, context.focus(), close, now);
			AgentInputState aim = look(player, target, 0.0F, 0.0F, false, true, player.getInventory().getSelectedSlot(), hand);
			if (below == null) {
				if (dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.needsFooting(player)) {
					aim = new AgentInputState(0, 0, false, false, false, false, true, aim.yaw(), 40.0F,
							aim.selectedSlot(), aim.hand());
				}
				input.accept(aim);
				return Step.running(held);
			}
			// Walking behind the shield: the action's keys, re-pressed for the shield's view so the body keeps its course.
			float[] keys = keysFor(below.forward(), below.strafe(), below.yaw(), aim.yaw());
			int slot = hand == InteractionHand.OFF_HAND ? below.selectedSlot() : aim.selectedSlot();
			input.accept(new AgentInputState(keys[0], keys[1], below.jump(), below.sneak(), false, false, true,
					aim.yaw(), aim.pitch(), slot, hand).withMovementBasis(below));
			return Step.running(held + (keys[0] != 0.0F || keys[1] != 0.0F ? "; walking" : ""));
		}

		/**
		 * One tick of a counter, or null to keep guarding. Starts only with the sword recharged, the shield in the
		 * offhand, a hostile in reach and every attacker near inside its cooldown with {@link #COUNTER_WINDOW_TICKS} to go;
		 * then the use key is released and the swing lands once the shield is down, as vanilla drops attack clicks while an
		 * item is in use.
		 */
		private Step counter(ServerPlayer player, Entity focus, List<Mob> close, long now, Consumer<AgentInputState> input) {
			if (hand != InteractionHand.OFF_HAND) return null;
			var range = player.getAttackRangeWith(player.getMainHandItem());
			Mob target = focus instanceof Mob mob && close.contains(mob) && range.isInRange(player, mob.getBoundingBox(), 0.0D) ? mob : null;
			if (target == null) {
				for (Mob mob : close) {
					if (range.isInRange(player, mob.getBoundingBox(), 0.0D)) {
						target = mob;
						break;
					}
				}
			}
			if (lowered == 0) {
				if (target == null || close.isEmpty() || player.getAttackStrengthScale(0.5F) < CombatPlanning.READY_ATTACK_STRENGTH) return null;
				for (Mob mob : close) {
					Long swung = swungAt.get(mob.getId());
					if (swung == null || now - swung > RECOVERY_TICKS - COUNTER_WINDOW_TICKS) return null;
				}
			} else if (target == null || lowered > COUNTER_LOWERED_TICKS) {
				lowered = 0;
				return null;
			}
			lowered++;
			input.accept(look(player, target.getBoundingBox().getCenter(), 0.0F, 0.0F, false, false,
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			if (!player.isUsingItem() && Tracer.rayTrace(player, 1.0F, range.effectiveMaxRange(player), false) instanceof EntityHitResult hit
					&& hit.getEntity() == target) {
				player.attack(target);
				ArmSwing.attack(player, InteractionHand.MAIN_HAND);
				player.resetAttackStrengthTicker();
				player.resetLastActionTime();
				countered++;
				lowered = 0;
				return Step.running("countered " + type(target) + " between its attacks");
			}
			return Step.running("lowering the shield to counter " + type(target));
		}

		/**
		 * Where the shield faces with no shot coming: toward every hostile within {@link #GUARD_RANGE} when one facing
		 * covers them all, else the nearest whose attack is not cooling down, else the condition's mob.
		 */
		private Vec3 guardPoint(ServerPlayer player, Entity focus, List<Mob> close, long now) {
			Vec3 fallback = focus == null || !focus.isAlive() ? null : ReflexSensors.aimPoint(focus);
			if (close.size() < 2) return fallback != null || close.isEmpty() ? fallback : ReflexSensors.aimPoint(close.getFirst());
			Vec3 eye = player.getEyePosition();
			double sumX = 0.0D, sumZ = 0.0D, sumY = 0.0D;
			for (Mob mob : close) {
				Vec3 to = ReflexSensors.aimPoint(mob).subtract(eye);
				double length = Math.hypot(to.x, to.z);
				if (length < 1.0E-3D) continue;
				sumX += to.x / length;
				sumZ += to.z / length;
				sumY += ReflexSensors.aimPoint(mob).y;
			}
			double meanLength = Math.hypot(sumX, sumZ);
			boolean covered = meanLength > 1.0E-3D;
			for (Mob mob : close) {
				Vec3 to = ReflexSensors.aimPoint(mob).subtract(eye);
				double length = Math.hypot(to.x, to.z);
				if (length < 1.0E-3D || !covered) continue;
				double cos = (to.x * sumX + to.z * sumZ) / (length * meanLength);
				if (Math.toDegrees(Math.acos(Mth.clamp(cos, -1.0D, 1.0D))) > GUARD_SPREAD_DEGREES) covered = false;
			}
			if (covered) return new Vec3(eye.x + sumX / meanLength * 2.0D, sumY / close.size(), eye.z + sumZ / meanLength * 2.0D);
			for (Mob mob : close) {
				Long swung = swungAt.get(mob.getId());
				if (swung == null || now - swung >= RECOVERY_TICKS - 5L) return ReflexSensors.aimPoint(mob);
			}
			return ReflexSensors.aimPoint(close.getFirst());
		}

		/** Hostile mobs within {@link #GUARD_RANGE} that the player can see, nearest first. */
		/** A swing that began this tick or the last (each target counts swing ticks its own way; see McCompat). */
		private static boolean swingJustStarted(Mob mob) {
			return McCompat.swingJustStarted(mob);
		}

		private static List<Mob> attackers(ServerPlayer player) {
			List<Mob> mobs = new ArrayList<>(player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(GUARD_RANGE),
					mob -> mob.isAlive() && ThreatPerception.isHostileTo(mob, player) && !mob.isInvisibleTo(player)
							&& player.distanceTo(mob) <= GUARD_RANGE && player.hasLineOfSight(mob)));
			mobs.sort(java.util.Comparator.comparingDouble(player::distanceTo));
			return mobs;
		}

		@Override
		public boolean holdsWhileTrue() { return true; }

		@Override
		public boolean passesMovement() { return true; }

		@Override
		public boolean defersToFight() { return defers; }

		/** A blaze volley is three shots about 0.3 s apart: a player keeps the shield up between them. */
		@Override
		public long releaseGraceTicks() { return SHIELD_GRACE_TICKS; }
	}

	/**
	 * Movement keys {forward, strafe} that move the body the same way as {@code forward}/{@code strafe} pressed while
	 * facing {@code fromYaw}, now pressed while facing {@code toYaw}, retaining analog length and direction.
	 */
	static float[] keysFor(float forward, float strafe, float fromYaw, float toYaw) {
		// Vanilla normalizes axes longer than one before movement. Rotate that effective input, so every
		// orientation fits AgentInputState's axis bounds without clipping or snapping small analog movement.
		double length = Math.hypot(forward, strafe);
		if (length > 1.0D) { forward /= (float) length; strafe /= (float) length; }
		double turn = Math.toRadians(fromYaw - toYaw);
		double rotatedStrafe = strafe * Math.cos(turn) - forward * Math.sin(turn);
		double rotatedForward = forward * Math.cos(turn) + strafe * Math.sin(turn);
		return new float[]{(float) rotatedForward, (float) rotatedStrafe};
	}

	static final class Defend implements Behaviour {
		/** How far cover is looked for: take_cover's reach in the coordinator's cover rule. */
		static final int COVER_WITHIN = 8;
		/** Hit by the attacker within this many ticks counts as under fire now. */
		static final int UNDER_FIRE_TICKS = 80;
		private final Shield guard = new Shield(false);
		private TakeCover cover;
		private WallIn walls;
		private int coverRetryTick = Integer.MIN_VALUE;
		private String coverNote;
		private int hits;
		private int guardTicks;
		/** The hotbar slot selected when the firing began: a changed slot is named so the model's next use_item knows. */
		private int startSlot = -1;
		static final int CROWD = 2;
		static final double CROWD_RANGE = 4.0D;
		private static final int SPAWNER_RANGE = 8;
		private static final double SPAWNER_ACTIVATION_RANGE = 16.0D;
		/** A backing-out run's length: sprint_away's own run, from the pack. */
		static final double BACK_OUT_BLOCKS = 8.0D;
		/** A failed back-out (no heading away) is not tried again until the body has moved this far from where it failed. */
		static final double BACK_OUT_RETRY_BLOCKS = 3.0D;
		private SprintAway backOut;
		private Mob backOutFocus;
		private Vec3 backOutPoint;
		private int nextSpawnerLook;
		private enum Retreat { CROWD, SPAWNER, WEAK }
		private Retreat retreat;
		private Vec3 backOutFailedAt;
		private int backOuts;
		private String backOutNote;
		/** This many of a melee mob's hits (after the body's armour) would kill the body: it backs away rather than trade. */
		static final int WEAK_HITS = 3;
		/**
		 * A mob the body backed away from that kept pace (still within {@link #CLOSING_RANGE} when the run ended, or hit the
		 * body during it): backing away from it again only turns the body's back, so defend fights it instead.
		 */
		private int keptPace = -1;
		private int backOutStartTick;

		private Mob outmatching(ServerPlayer player, Mob mob) {
			if (mob == null || mob.getId() == keptPace) return null;
			double hit = ThreatDamage.expectedHit(mob, player).damage();
			if (hit <= 0.0D || player.getHealth() + player.getAbsorptionAmount() > WEAK_HITS * hit) return null;
			return outpaces(runSpeed(player), mob.getAttributeValue(net.minecraft.world.entity.ai.attributes.Attributes.MOVEMENT_SPEED)) ? mob : null;
		}

		/** Only a spawner the player can see can turn an ordinary melee fight into a retreat. */
		private void lookForSpawner(ServerPlayer player, ReflexSensors.Memory memory) {
			if (player.tickCount < nextSpawnerLook) return;
			nextSpawnerLook = player.tickCount + 10;
			BlockPos feet = player.blockPosition();
			var level = player.level();
			var sight = ObservationVisibility.frame(level, player);
			for (int cx = (feet.getX() - SPAWNER_RANGE) >> 4; cx <= (feet.getX() + SPAWNER_RANGE) >> 4; cx++) {
				for (int cz = (feet.getZ() - SPAWNER_RANGE) >> 4; cz <= (feet.getZ() + SPAWNER_RANGE) >> 4; cz++) {
					var chunk = level.getChunkSource().getChunkNow(cx, cz);
					if (chunk == null) continue;
					for (var entry : chunk.getBlockEntities().entrySet()) {
						BlockPos at = entry.getKey();
						if (entry.getValue() instanceof SpawnerBlockEntity && at.distSqr(feet) <= SPAWNER_RANGE * SPAWNER_RANGE
								&& sight.canSeeBlock(at)) {
							memory.rememberSpawner(at, player.tickCount);
							return;
						}
					}
				}
			}
		}

		private void startBackOut(ServerPlayer player, Retreat cause, Mob focus, Vec3 point) {
			backOut = switch (cause) {
				case SPAWNER -> new SprintAway(SPAWNER_ACTIVATION_RANGE, SprintAway.BACK_OUT_DROP, true);
				case CROWD -> new SprintAway(BACK_OUT_BLOCKS, SprintAway.BACK_OUT_DROP, true);
				default -> new SprintAway(BACK_OUT_BLOCKS, SprintAway.BACK_OUT_DROP);
			};
			retreat = cause;
			backOutFocus = focus;
			backOutPoint = point;
			backOuts++;
			backOutStartTick = player.tickCount;
		}

		private boolean canBackOut(ServerPlayer player) {
			return backOutFailedAt == null || player.position().distanceTo(backOutFailedAt) > BACK_OUT_RETRY_BLOCKS;
		}

		/** A run from one mob pays only when the mob's chase is at most this share of the body's run: it falls behind. */
		static final double OUTPACE_SHARE = 0.8D;
		/** Vanilla's sprint modifier: sprinting multiplies a player's movement speed by 1.3. */
		static final double SPRINT_FACTOR = 1.3D;

		/**
		 * Whether a body running at {@code bodySpeed} (a player's movement speed, sprint included) leaves behind a mob with
		 * movement speed {@code mobSpeed}. The two are not the same unit: a mob's move control sets both its speed and its
		 * forward input to that value (Mob.setSpeed), so it accelerates by the square, where a player's forward key is 1.
		 * On flat ground a zombie (0.23) chases at 0.053, a baby zombie (0.345) at 0.119, a spider or enderman (0.3) at 0.09;
		 * a player walks at 0.1 and sprints at 0.13.
		 */
		static boolean outpaces(double bodySpeed, double mobSpeed) {
			return mobSpeed * mobSpeed <= OUTPACE_SHARE * bodySpeed;
		}

		/** The body's movement speed on a run: sprinting when its food allows (as SprintAway runs), else walking. */
		static double runSpeed(ServerPlayer player) {
			double speed = player.getAttributeValue(net.minecraft.world.entity.ai.attributes.Attributes.MOVEMENT_SPEED);
			double walk = player.isSprinting() ? speed / SPRINT_FACTOR : speed;
			return canSprint(player) ? walk * SPRINT_FACTOR : walk;
		}
		private boolean chased;
		static final long CHASED_GRACE_TICKS = 200L;
		/** How far a melee mob after the body still counts as chasing it: a back-out leaves the pack about 8-9 blocks behind. */
		static final double CHASE_RANGE = 16.0D;

		/** A melee mob within {@link #CHASE_RANGE} has the body as its target (sight not needed: it is following it). */
		static boolean chasing(ServerPlayer player) {
			return nearestChaser(player, CHASE_RANGE) < CHASE_RANGE;
		}

		static double nearestChaser(ServerPlayer player, double within) {
			double nearest = within;
			for (Mob mob : player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(within),
					mob -> mob.isAlive() && mob.getTarget() == player && packMember(mob, player))) {
				nearest = Math.min(nearest, player.distanceTo(mob));
			}
			return nearest;
		}

		boolean backingOutOfPack() {
			return backOut != null && retreat != Retreat.WEAK;
		}

		@Override
		public void end(ServerPlayer player) {
			guard.end(player);
			if (cover != null) cover.end(player);
			if (backOut != null) backOut.end(player);
			if (walls != null) walls.end(player);
			dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.keepLevel(player, this, false);
		}

		/** How far defend looks for a stand off a brink before it walls in (a 3-wide bridge's middle is 1 away). */
		static final int INLAND_WITHIN = 3;
		/** Ticks a step inland may take before defend gives it up (a crouched step is about 1.3 blocks a second). */
		static final int INLAND_TICKS = 60;
		/** Where defend is stepping to before it walls in, off a brink under fire; null when not stepping. */
		private Vec3 inland;
		private int inlandTicks;
		/** Set during a tick: no stand off the brink was found, so the body braces where it is (the guard leans inland). */
		private boolean braceInPlace;
		/** Until this tick the body braces in place without looking again for a stand (the search reads many columns). */
		private int braceUntil = Integer.MIN_VALUE;
		private String braceNote;
		private boolean inlandTouched;
		private int airTicks;

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			braceInPlace = false;
			inlandTouched = false;
			Step step = act(context, input);
			// A step target is only good while the step branch runs each tick: after a fight or back-out it is stale.
			if (!inlandTouched) inland = null;
			// Held from this tick's state only, so it never outlives the reason (a leaked holder freezes every walk-off).
			dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.keepLevel(context.player(), this, braceInPlace, true);
			return step;
		}

		/**
		 * Off a brink before walls go up: a shooter beyond reach, blocks to build and a lethal or unseen drop within a shove
		 * of where the body would stand. It steps crouched to the nearest seen stand on its level with no brink in reach,
		 * then walls in there; with none in reach it braces where it stands. Null when the body may wall in where it is.
		 */
		private Step offBrink(ServerPlayer player, LivingEntity shooter, Consumer<AgentInputState> input, String done) {
			inlandTouched = true;
			// In the air (a hit's hop) every shove reads as a survivable drop onto the deck below: judge the brink once landed.
			airTicks = player.onGround() ? 0 : airTicks + 1;
			// Afloat, climbing or caught in a web is not a hit's hop: no wait there, and none past a second.
			if (!player.onGround() && !player.isInWater() && !player.isInLava() && !player.onClimbable() && airTicks <= 20) {
				dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.braceArmed(player);
				input.accept(look(player, ReflexSensors.aimPoint(shooter), 0.0F, 0.0F, false, false, player.getInventory().getSelectedSlot(),
						InteractionHand.MAIN_HAND));
				return Step.running(done + "; in the air after a hit, waiting to land before walling in from " + type(shooter));
			}
			if (inland == null && player.tickCount < braceUntil) return null;
			if (inland == null) {
				BlockPos cell = BlockPos.containing(player.getX(), player.getY() + 0.2D, player.getZ());
				String brink = WallIn.brink(dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.brinkFrom(player, new Vec3(cell.getX() + 0.5D, player.getY(), cell.getZ() + 0.5D),
						shooter.position()));
				if (brink == null) return null;
				inland = dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.inlandStand(player, INLAND_WITHIN, shooter.position());
				inlandTicks = 0;
				if (inland == null) {
					// No stand to wall in from: natural cover if a cell in reach hides, else brace where it stands.
					braceUntil = player.tickCount + 40;
					braceNote = "not walling in: " + brink + "; no stand off it in " + INLAND_WITHIN + " blocks";
					return null;
				}
			}
			double dx = inland.x - player.getX(), dz = inland.z - player.getZ();
			if (dx * dx + dz * dz <= 0.15D * 0.15D || ++inlandTicks > INLAND_TICKS || Math.abs(player.getY() - inland.y) > 0.6D) {
				// Arrived, out of time, or off the level: the wall-in judges the cell it stands on now. A step that did not
				// arrive is not tried again at once (the same stand would be chosen): the body braces for a while instead.
				boolean timedOut = inlandTicks > INLAND_TICKS && dx * dx + dz * dz > 0.15D * 0.15D;
				inland = null;
				if (timedOut) {
					braceUntil = player.tickCount + 40;
					braceNote = "the step inland did not reach its stand";
				}
				return null;
			}
			// Crouched (vanilla keeps a crouched body on its block's edge) with a shove's walk-back armed.
			dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.braceArmed(player);
			float[] keys = dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.keysToward(player.getYRot(), dx, dz);
			input.accept(new AgentInputState(keys[0], keys[1], false, true, false, false, false, player.getYRot(), player.getXRot(),
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return Step.running(done + "; stepping inland off the edge to wall in from " + type(shooter));
		}

		private Step bracing(ServerPlayer player, LivingEntity shooter, Consumer<AgentInputState> input, String done) {
			braceInPlace = true;
			input.accept(look(player, ReflexSensors.aimPoint(shooter), 0.0F, 0.0F, false, false, player.getInventory().getSelectedSlot(),
					InteractionHand.MAIN_HAND));
			return Step.running(done + "; " + braceNote + ", bracing against " + type(shooter) + "'s shots where the body stands"
					+ (coverNote == null ? "" : "; cover: " + coverNote));
		}

		private Step act(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			chased = backOuts > 0 && chasing(player);
			// Walls going up: finish them while this firing lasts (it ends at its maxS or the model's next command).
			if (walls != null) {
				Step built = walls.tick(context, input);
				if (built.status() == ReflexScheduler.ActionStatus.RUNNING) return Step.running(built.detail());
				coverNote = built.detail();
				walls.end(player);
				walls = null;
				coverRetryTick = player.tickCount + 40;
				return built.status() == ReflexScheduler.ActionStatus.DONE ? Step.done(built.detail()) : Step.failed(built.detail());
			}
			List<Mob> crowd = meleeNear(player, CROWD_RANGE);
			// One melee mob coming at a body it would kill in WEAK_HITS hits is backed away from too, before the hit lands:
			// a trade of blows at that health is lost (gate2A-2, gate2A-8: 8-9 health and no food, a zombie walked up while
			// the model thought and its first hits began the end).
			Mob closing = closingMelee(player);
			if (backOut == null && canBackOut(player)) {
				if (closing != null || !crowd.isEmpty()) lookForSpawner(player, context.memory());
				BlockPos spawner = context.memory().recentSpawner(player.tickCount);
				// Once outside activation range, a pack can still catch up. Keep running outward if it does.
				double spawnerRange = crowd.size() >= CROWD ? SPAWNER_ACTIVATION_RANGE + CHASE_RANGE : SPAWNER_ACTIVATION_RANGE;
				if (closing != null && spawner != null && player.blockPosition().distSqr(spawner) <= spawnerRange * spawnerRange
						&& player.level().getBlockState(spawner).is(Blocks.SPAWNER)) {
					startBackOut(player, Retreat.SPAWNER, closing, Vec3.atCenterOf(spawner));
				} else if (crowd.size() >= CROWD) {
					startBackOut(player, Retreat.CROWD, crowd.getFirst(), null);
				} else {
					Mob outmatching = outmatching(player, closing);
					if (outmatching != null) startBackOut(player, Retreat.WEAK, outmatching, null);
				}
			}
			// Backing away from one mob that still lands hits keeps pace after all (food ran out mid-run, rough ground):
			// the run stops and defend fights it below this tick.
			if (backOut != null && retreat == Retreat.WEAK && crowd.size() < CROWD && player.getLastHurtByMob() instanceof Mob hitter
					&& player.getLastHurtByMobTimestamp() > backOutStartTick && closing == hitter) {
				backOut.end(player);
				backOut = null;
				keptPace = hitter.getId();
				backOutNote = "stopped backing away: " + type(hitter) + " kept pace and hit";
			}
			if (backOut != null) {
				Mob nearest = retreat == Retreat.CROWD && !crowd.isEmpty() ? crowd.getFirst() : backOutFocus;
				Step ran = backOut.tick(new Context(player, backOutPoint == null ? nearest : null, context.stance(), context.memory(),
						backOutPoint, context.below(), context.fightShields()), input);
				if (ran.status() == ReflexScheduler.ActionStatus.RUNNING) {
					String why = switch (retreat) {
						case WEAK -> "backing away from " + type(nearest) + " (" + WEAK_HITS + " of its hits would kill the body)";
						case CROWD -> "backing out of " + crowd.size() + " mobs";
						case SPAWNER -> "backing away from a spawner";
					};
					return Step.running(hits + " hit(s) back; " + why + ": " + ran.detail());
				}
				// A finished or failed run applies no input this tick (SprintAway), so defend's own answer below takes it.
				backOut.end(player);
				backOut = null;
				backOutNote = (ran.status() == ReflexScheduler.ActionStatus.DONE ? "backed out: " : "could not back out: ") + ran.detail();
				if (ran.status() != ReflexScheduler.ActionStatus.DONE) backOutFailedAt = player.position();
				// A full run that still ends with the mob about to reach the body was not outrun: no second run from it.
				Mob still = retreat == Retreat.WEAK ? closingMelee(player) : null;
				if (still != null && ran.status() == ReflexScheduler.ActionStatus.DONE) {
					keptPace = still.getId();
					backOutNote += "; " + type(still) + " kept pace";
				}
			}
			boolean shield = player.getOffhandItem().is(Items.SHIELD) || player.getMainHandItem().is(Items.SHIELD);
			Entity shot = ReflexSensors.incomingShot(player, SHIELD_SHOT_SECONDS);
			int weapon = dev.agaminggod.mineagen.server.runtime.controller.HotbarWeapons.bestSlotOrNone(player);
			if (startSlot < 0) startSlot = player.getInventory().getSelectedSlot();
			int slot = weapon >= 0 && !player.getMainHandItem().is(Items.SHIELD) ? weapon : player.getInventory().getSelectedSlot();
			Swing swing = shot != null && shield ? null : inReach(player, context.focus(), player.getInventory().getItem(slot));
			LivingEntity target = swing == null ? null : swing.target();
			int selected = target != null ? slot : player.getInventory().getSelectedSlot();
			String done = hits + " hit(s) back" + (guardTicks > 0 ? ", shield up " + Math.round(guardTicks / 2.0D) / 10.0D + " s" : "")
					+ (selected != startSlot ? ", hotbar slot " + selected + " selected (was " + startSlot + ")" : "")
					+ (backOutNote != null ? ", " + backOuts + " back-out(s), last " + backOutNote : "");
			if (target != null) {
				// Aim at the part of the hitbox the eye can see: round a corner its middle can sit behind the stone.
				input.accept(look(player, swing.aim(), 0.0F, 0.0F, false, false, slot, InteractionHand.MAIN_HAND));
				var range = player.getAttackRangeWith(player.getMainHandItem());
				boolean ready = player.getInventory().getSelectedSlot() == slot && !player.isUsingItem()
						&& player.getAttackStrengthScale(0.5F) >= CombatPlanning.READY_ATTACK_STRENGTH;
				if (ready && Tracer.rayTrace(player, 1.0F, range.effectiveMaxRange(player), false) instanceof EntityHitResult hit && hit.getEntity() == target) {
					player.attack(target);
					ArmSwing.attack(player, InteractionHand.MAIN_HAND);
					player.resetAttackStrengthTicker();
					player.resetLastActionTime();
					hits++;
				}
				return Step.running(done + "; fighting " + type(target));
			}
			if (shield) {
				Step held = guard.tick(context, input);
				if (held.status() == ReflexScheduler.ActionStatus.RUNNING) guardTicks++;
				return Step.running(done + "; " + held.detail());
			}
			LivingEntity shooter = shooterBeyondReach(player, context.focus(), player.getInventory().getItem(slot));
			boolean canWall = PlaceBlock.blockSlot(player, null) >= 0 && nearestChaser(player, PACK_RANGE) >= PACK_RANGE;
			// A ranged mob beyond reach that is the focus but has not hit yet: on a lip its first hit is the fall (four
			// traced lava-sea deaths: the first fireball knocked the body off), so the step inland does not wait for it.
			LivingEntity ranged = shooter != null ? shooter : rangedBeyondReach(player, context.focus(), player.getInventory().getItem(slot));
			// With a melee mob near, defend's other answers come first: no crouched step with a zombie at the body's back.
			if (ranged == null || walls != null || nearestChaser(player, PACK_RANGE) < PACK_RANGE) inland = null;
			else if ((player.tickCount >= coverRetryTick || inland != null) && cover == null) {
				Step stepping = offBrink(player, ranged, input, done);
				if (stepping != null) return stepping;
			}
			boolean ledged = ranged != null && walls == null && player.tickCount < braceUntil;
			if (shooter != null && walls == null && player.tickCount >= coverRetryTick && canWall && !ledged && cover == null) walls = new WallIn(shooter);
			if (walls != null) {
				Step built = walls.tick(context, input);
				if (built.status() == ReflexScheduler.ActionStatus.RUNNING) return Step.running(done + "; " + built.detail());
				coverNote = built.detail();
				walls.end(player);
				walls = null;
				coverRetryTick = player.tickCount + 40;
				if (built.status() == ReflexScheduler.ActionStatus.DONE) return Step.done(done + "; " + built.detail());
			}
			// No blocks, or a melee mob too near to stand building: a corner in reach is the cover.
			if (shooter != null && (!canWall || ledged || cover != null) && (cover != null || player.tickCount >= coverRetryTick)) {
				// Natural cover only: building walls is the branch above, which a melee mob this near rules out.
				if (cover == null) cover = new TakeCover(COVER_WITHIN, false, false, false);
				// Looking round for cover off a brink: a shove meanwhile is still walked back.
				if (ledged) dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.braceArmed(player);
				Step hidden = cover.tick(new Context(player, shooter, context.stance(), context.memory(), context.point(), context.below(),
						context.fightShields()), input);
				if (hidden.status() == ReflexScheduler.ActionStatus.RUNNING) return Step.running(done + "; taking cover from " + type(shooter) + ": " + hidden.detail());
				// In cover (or none found): look again a second later, so a shooter that moves round is answered too.
				coverNote = hidden.detail();
				cover.end(player);
				cover = null;
				coverRetryTick = player.tickCount + (hidden.status() == ReflexScheduler.ActionStatus.DONE ? 20 : 40);
				// No cover off a brink: keep bracing until the next look, not only for what is left of the brace window.
				if (ledged) braceUntil = Math.max(braceUntil, coverRetryTick);
			}
			if (ledged) return bracing(player, ranged, input, done);
			Entity focus = context.focus();
			Vec3 at = focus != null && focus.isAlive() ? ReflexSensors.aimPoint(focus instanceof Projectile p && p.getOwner() != null ? p.getOwner() : focus) : null;
			input.accept(look(player, at, 0.0F, 0.0F, false, false, slot, InteractionHand.MAIN_HAND));
			return Step.running(done + "; no shield, facing the attacker" + (coverNote == null ? "" : "; cover: " + coverNote));
		}

		/**
		 * The ranged attacker (or a shot's shooter) that hit the body within {@link #UNDER_FIRE_TICKS} and stands beyond the
		 * weapon's reach, or null. In reach, or not the one that hit it, defend goes on as before.
		 */
		static LivingEntity shooterBeyondReach(ServerPlayer player, Entity focus, ItemStack weapon) {
			Entity source = focus instanceof Projectile shot ? shot.getOwner() : focus;
			LivingEntity attacker = player.getLastHurtByMob();
			if (!(source instanceof LivingEntity living) || living != attacker || !living.isAlive()) return null;
			if (player.tickCount - player.getLastHurtByMobTimestamp() > UNDER_FIRE_TICKS) return null;
			if (!(focus instanceof Projectile) && !(living instanceof Mob mob && ThreatPerception.isRanged(mob))) return null;
			return player.getAttackRangeWith(weapon).isInRange(player, living.getBoundingBox(), 0.0D) ? null : living;
		}

		/** The focus (or a shot's shooter) when it is a ranged mob standing beyond the weapon's reach, hit or not; else null. */
		static LivingEntity rangedBeyondReach(ServerPlayer player, Entity focus, ItemStack weapon) {
			Entity source = focus instanceof Projectile shot ? shot.getOwner() : focus;
			if (!(source instanceof Mob mob) || !mob.isAlive() || !ThreatPerception.isRanged(mob)) return null;
			return player.getAttackRangeWith(weapon).isInRange(player, mob.getBoundingBox(), 0.0D) ? null : mob;
		}

		/** A mob defend can hit now and the point of its hitbox the swing aims at. */
		record Swing(LivingEntity target, Vec3 aim) { }

		/**
		 * The attacker if a swing can hit it, else the nearest hostile a swing can hit, else null. A swing can hit a mob
		 * when part of its hitbox is in the weapon's reach with no block between it and the eye: the eye seeing the mob's
		 * eye is not enough, since round a corner its middle can sit behind the stone while its head shows.
		 */
		private static Swing inReach(ServerPlayer player, Entity focus, ItemStack weapon) {
			if (focus instanceof LivingEntity living && living.isAlive()) {
				Vec3 aim = swingPoint(player, living, weapon);
				if (aim != null) return new Swing(living, aim);
			}
			Swing nearest = null;
			double best = Double.POSITIVE_INFINITY;
			for (Mob mob : player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(6.0D),
					mob -> mob.isAlive() && ThreatPerception.isHostileTo(mob, player) && !mob.isInvisibleTo(player))) {
				double distance = player.distanceTo(mob);
				if (distance >= best) continue;
				Vec3 aim = swingPoint(player, mob, weapon);
				if (aim == null) continue;
				best = distance;
				nearest = new Swing(mob, aim);
			}
			return nearest;
		}

		/** The visible point of the mob's hitbox within the weapon's reach (fight_target's test), or null. */
		static Vec3 swingPoint(ServerPlayer player, LivingEntity mob, ItemStack weapon) {
			var range = player.getAttackRangeWith(weapon);
			if (!range.isInRange(player, mob.getBoundingBox(), 0.0D)) return null;
			return dev.agaminggod.mineagen.server.runtime.TargetSightline.entity(player.level(),
					net.minecraft.world.phys.shapes.CollisionContext.of(player), player.getEyePosition(), mob.getBoundingBox(),
					range.effectiveMaxRange(player));
		}

		@Override
		public boolean holdsWhileTrue() { return true; }

		@Override
		public long releaseGraceTicks() { return backOut != null || chased ? CHASED_GRACE_TICKS : SHIELD_GRACE_TICKS; }
	}

	/** Aim at the focus and swing when the crosshair is on it and the attack has recharged; a trigger swings once. */
	static final class Attack implements Behaviour {
		/** A mob just outside reach is faced and awaited this long, as a player turns and swings when it arrives. */
		private static final int APPROACH_TICKS = 20;
		private int hits;
		private int waited;
		/** The hotbar weapon a player swaps to before swinging (sword over axe over tool), chosen once per firing. */
		private int weapon = -1;

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (!(context.focus() instanceof LivingEntity target) || !target.isAlive()) {
				return hits > 0 ? Step.done(hits + " hit(s)") : Step.failed("no target in reach");
			}
			if (weapon < 0) weapon = CombatPlanning.bestWeaponSlot(HotbarWeapons.candidates(player), player.getInventory().getSelectedSlot());
			var range = player.getAttackRangeWith(player.getMainHandItem());
			// The dragon's root is not pickable: a player hits it through a part, the head taking full damage.
			Entity aim = target instanceof EnderDragon dragon ? dragonPart(player, dragon) : target;
			if (!range.isInRange(player, aim.getBoundingBox(), 0.0D)) {
				if (hits > 0) return Step.done(hits + " hit(s)");
				if (++waited > APPROACH_TICKS || player.distanceTo(aim) > range.effectiveMaxRange(player) + 2.0D) return Step.failed("target out of reach");
				input.accept(look(player, aim.getBoundingBox().getCenter(), 0.0F, 0.0F, false, false,
						weapon, InteractionHand.MAIN_HAND));
				return Step.running("facing " + type(target));
			}
			input.accept(look(player, aim.getBoundingBox().getCenter(), 0.0F, 0.0F, false, false,
					weapon, InteractionHand.MAIN_HAND));
			// The swap lands on the next tick; the swing waits for it (and for the charge it resets, as a player's does).
			boolean ready = player.getInventory().getSelectedSlot() == weapon
					&& player.getAttackStrengthScale(0.5F) >= CombatPlanning.READY_ATTACK_STRENGTH && !player.isUsingItem();
			if (ready && Tracer.rayTrace(player, 1.0F, range.effectiveMaxRange(player), false) instanceof EntityHitResult hit
					&& (hit.getEntity() == target || hit.getEntity() instanceof EnderDragonPart part && part.parentMob == target)) {
				player.attack(hit.getEntity());
				ArmSwing.attack(player, InteractionHand.MAIN_HAND);
				player.resetAttackStrengthTicker();
				player.resetLastActionTime();
				hits++;
				if (!context.stance()) return Step.done("hit " + type(target));
			}
			return Step.running(hits + " hit(s)");
		}
	}

	/** The dragon part a swing aims at: the head when in reach, else the nearest part in reach, else the head. */
	static Entity dragonPart(ServerPlayer player, EnderDragon dragon) {
		var range = player.getAttackRangeWith(player.getMainHandItem());
		Entity best = null;
		double nearest = Double.POSITIVE_INFINITY;
		for (EnderDragonPart part : dragon.getSubEntities()) {
			if (part == null || !range.isInRange(player, part.getBoundingBox(), 0.0D)) continue;
			if (part == dragon.head) return part;
			double distance = part.getBoundingBox().distanceToSqr(player.getEyePosition());
			if (distance < nearest) { nearest = distance; best = part; }
		}
		return best != null ? best : dragon.head;
	}

	/** Back away from the focus (or from the view) onto known safe footing, facing what it backs from. */
	static final class StepBack implements Behaviour {
		private static final float[] OFFSETS = {0.0F, 45.0F, -45.0F, 90.0F, -90.0F};
		private final double blocks;
		private Vec3 start;
		private int ticks;
		private float awayYaw = Float.NaN;
		private Float lastHeading;

		StepBack(double blocks) {
			this.blocks = blocks;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (start == null) start = player.position();
			ticks++;
			double moved = Math.hypot(player.getX() - start.x, player.getZ() - start.z);
			if (moved >= blocks) return Step.done(String.format(Locale.ROOT, "stepped back %.1f blocks", moved));
			Entity focus = context.focus() != null && context.focus().isAlive() ? context.focus() : null;
			if (focus != null) {
				Vec3 delta = player.position().subtract(focus.position());
				awayYaw = (float) Math.toDegrees(Math.atan2(-delta.x, delta.z));
			} else if (Float.isNaN(awayYaw)) {
				awayYaw = player.getYRot() + 180.0F;
			}
			Float heading = SafeStep.heading(player, awayYaw, OFFSETS, lastHeading);
			lastHeading = heading;
			if (heading == null) {
				return moved >= 0.3D ? Step.done(String.format(Locale.ROOT, "stepped back %.1f blocks; no safe cell further", moved))
						: Step.failed("no safe cell behind");
			}
			if (ticks >= 20 && moved < 0.2D) return Step.failed("blocked while stepping back");
			AgentInputState aim = look(player, focus == null ? null : focus.getBoundingBox().getCenter(), 0.0F, 0.0F, false, false,
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND);
			// Keys relative to the view: backpedal and strafe toward the safe heading while still facing the threat.
			float relative = (float) Math.toRadians(AgentInputStates.shortestAngleDelta(aim.yaw(), heading));
			float forward = clean((float) Math.cos(relative));
			float strafe = clean(-(float) Math.sin(relative));
			input.accept(new AgentInputState(forward, strafe, false, false, false, false, false,
					aim.yaw(), aim.pitch(), aim.selectedSlot(), aim.hand()));
			return Step.running(String.format(Locale.ROOT, "stepping back %.1f/%.1f", moved, blocks));
		}

		private static float clean(float value) {
			return Math.abs(value) < 1.0E-4F ? 0.0F : Mth.clamp(value, -1.0F, 1.0F);
		}
	}

	/**
	 * Eat the food a player would pick now, from the offhand or the hotbar: the one that fills the hunger gap best with
	 * the most saturation and the least waste. Foods with a harmful effect (rotten flesh, spider eyes, poisonous potatoes,
	 * pufferfish, suspicious stew) or a side effect (chorus fruit teleports) are eaten only when nothing else is held,
	 * and golden apples are kept for low health ({@link #bestFood}).
	 */
	static final class Eat implements Behaviour {
		/** Use held this long without the body starting to eat is a failed meal, not a wait (eating starts on the first tick). */
		static final int START_TICKS = 10;
		/** Facing within this of the chosen look counts as there; the use key goes down only then. */
		static final float AIM_TOLERANCE_DEGREES = 2.0F;
		private int slot = -2;
		private InteractionHand hand;
		private String item;
		private int count;
		private float lookYaw;
		private float lookPitch;
		private String facing;
		private int heldTicks;

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (slot == -2) {
				List<FoodOption> options = new ArrayList<>(10);
				for (int index = 0; index < 9; index++) options.add(FoodOption.of(player, player.getInventory().getItem(index)));
				options.add(FoodOption.of(player, player.getOffhandItem()));
				int best = bestFood(options, 20 - player.getFoodData().getFoodLevel(), player.getHealth());
				if (best < 0) return Step.failed(anyFood(player) ? "hunger is full" : "no food in hotbar or offhand");
				hand = best == 9 ? InteractionHand.OFF_HAND : InteractionHand.MAIN_HAND;
				slot = best == 9 ? player.getInventory().getSelectedSlot() : best;
				ItemStack stack = hand == InteractionHand.OFF_HAND ? player.getOffhandItem() : player.getInventory().getItem(slot);
				item = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				count = stack.getCount();
				// Use goes to what the crosshair is on before the food (a table opens, a villager trades), so a player
				// turns from it first. Live playtest: 32 eats in a row faced the crafting table just placed, reopened it
				// every few ticks and timed out, with the bread craft paused under them for minutes.
				float[] clear = clearLook(player);
				lookYaw = clear[0];
				lookPitch = clear[1];
				facing = useTarget(player, player.getYRot(), player.getXRot());
			}
			ItemStack now = hand == InteractionHand.OFF_HAND ? player.getOffhandItem() : player.getInventory().getItem(slot);
			if (now.isEmpty() || !item.equals(BuiltInRegistries.ITEM.getKey(now.getItem()).toString()) || now.getCount() < count) {
				return Step.done("ate " + item);
			}
			float yaw = AgentInputStates.turnYaw(player.getYRot(), lookYaw);
			float pitch = AgentInputStates.turnPitch(player.getXRot(), lookPitch);
			boolean aimed = Math.abs(AgentInputStates.shortestAngleDelta(player.getYRot(), lookYaw)) <= AIM_TOLERANCE_DEGREES
					&& Math.abs(player.getXRot() - lookPitch) <= AIM_TOLERANCE_DEGREES;
			if (aimed && !player.isUsingItem() && ++heldTicks > START_TICKS) {
				String target = useTarget(player, player.getYRot(), player.getXRot());
				return Step.failed("could not start eating " + item + (target != null ? "; use goes to the " + target
						: facing != null ? "; turned from the " + facing + " and still could not" : ""));
			}
			input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, false, aimed,
					yaw, pitch, slot, hand));
			return Step.running((aimed ? "eating " : "turning to eat ") + item);
		}

		/**
		 * The look to eat with: the current one when use would reach no block or entity that answers it, else the first
		 * clear one of looking up, down, then around at eye level and half up. With none clear, the current look (the meal
		 * then fails fast and says what is in the way instead of holding the body).
		 */
		static float[] clearLook(ServerPlayer player) {
			float yaw = player.getYRot();
			float pitch = player.getXRot();
			if (useTarget(player, yaw, pitch) == null) return new float[] {yaw, pitch};
			float[][] candidates = {{yaw, -90.0F}, {yaw, 90.0F}, {yaw + 90.0F, 0.0F}, {yaw - 90.0F, 0.0F}, {yaw + 180.0F, 0.0F},
					{yaw + 90.0F, -45.0F}, {yaw - 90.0F, -45.0F}, {yaw + 180.0F, -45.0F}};
			for (float[] candidate : candidates) {
				float candidateYaw = Mth.wrapDegrees(candidate[0]);
				if (useTarget(player, candidateYaw, candidate[1]) == null) return new float[] {candidateYaw, candidate[1]};
			}
			return new float[] {yaw, pitch};
		}

		/** What a use press at this look would act on instead of eating (a block with a use, an entity), or null for none. */
		static String useTarget(ServerPlayer player, float yaw, float pitch) {
			Vec3 eye = player.getEyePosition();
			Vec3 direction = Vec3.directionFromRotation(pitch, yaw);
			Vec3 blockEnd = eye.add(direction.scale(player.blockInteractionRange()));
			BlockHitResult block = player.level().clip(new ClipContext(eye, blockEnd, ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
			double blockDistance = block.getType() == HitResult.Type.MISS ? Double.MAX_VALUE : block.getLocation().distanceTo(eye);
			Vec3 entityEnd = eye.add(direction.scale(Math.min(player.entityInteractionRange(), blockDistance)));
			for (Entity entity : player.level().getEntities(player, new AABB(eye, entityEnd).inflate(1.0D),
					candidate -> candidate.isPickable() && !candidate.isSpectator())) {
				if (entity.getBoundingBox().inflate(entity.getPickRadius()).clip(eye, entityEnd).isPresent())
					return BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).getPath();
			}
			if (block.getType() == HitResult.Type.MISS) return null;
			BlockState state = player.level().getBlockState(block.getBlockPos());
			return answersUse(player.level(), block.getBlockPos(), state) ? BuiltInRegistries.BLOCK.getKey(state.getBlock()).getPath() : null;
		}

		/** Blocks whose use acts before the held food: menus, block entities, doors and switches, beds, a composter. */
		static boolean answersUse(Level level, BlockPos pos, BlockState state) {
			if (state.getBlock() instanceof EntityBlock || state.getMenuProvider(level, pos) != null) return true;
			if (state.is(net.minecraft.tags.BlockTags.DOORS) || state.is(net.minecraft.tags.BlockTags.TRAPDOORS)
					|| state.is(net.minecraft.tags.BlockTags.FENCE_GATES) || state.is(net.minecraft.tags.BlockTags.BUTTONS)
					|| state.is(net.minecraft.tags.BlockTags.BEDS)) return true;
			return USE_BLOCKS.contains(BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString());
		}

		// Ids, not Blocks fields: a static Blocks reference would load the registries with this class in pure tests.
		private static final Set<String> USE_BLOCKS = Set.of("minecraft:lever", "minecraft:composter", "minecraft:cake",
				"minecraft:note_block", "minecraft:repeater", "minecraft:comparator", "minecraft:respawn_anchor", "minecraft:dragon_egg");

		private static boolean edible(ServerPlayer player, FoodProperties food) {
			return food != null && player.canEat(food.canAlwaysEat());
		}

		/** Foods whose effect hurts (poison, nausea, hunger, a random stew) or moves the body (chorus fruit). */
		static final Set<String> LAST_RESORT_FOODS = Set.of("minecraft:rotten_flesh", "minecraft:spider_eye", "minecraft:poisonous_potato",
				"minecraft:pufferfish", "minecraft:suspicious_stew", "minecraft:chorus_fruit", "minecraft:chicken");
		/** Kept for healing: their absorption and regeneration are worth far more than their hunger points. */
		static final Set<String> HEALING_FOODS = Set.of("minecraft:golden_apple", "minecraft:enchanted_golden_apple");
		/** At or below this health a golden apple is the right thing to eat. */
		static final float HEALING_FOOD_HEALTH = 8.0F;

		/** One hand or hotbar slot as the food choice reads it; {@link #NONE} when it holds nothing edible now. */
		record FoodOption(String id, int nutrition, float saturation) {
			static final FoodOption NONE = new FoodOption(null, 0, 0.0F);

			static FoodOption of(ServerPlayer player, ItemStack stack) {
				FoodProperties food = stack.isEmpty() ? null : stack.get(DataComponents.FOOD);
				return edible(player, food) ? new FoodOption(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(), food.nutrition(), food.saturation()) : NONE;
			}
		}

		/**
		 * The index of the food to eat among hotbar slots 0..8 and the offhand (9), or -1 for none. Ordinary food scores
		 * the hunger it fills plus its saturation minus half the hunger it wastes; healing foods come next (first at low
		 * health), and last-resort foods only when nothing else is held. Ties keep the offhand, then the lower slot.
		 */
		static int bestFood(List<FoodOption> options, int hungerGap, float health) {
			int best = -1;
			double bestScore = Double.NEGATIVE_INFINITY;
			for (int index = 0; index < options.size(); index++) {
				FoodOption food = options.get(index);
				if (food == null || food.id() == null) continue;
				double fill = Math.min(food.nutrition(), Math.max(0, hungerGap));
				double score = fill + food.saturation() - 0.5D * Math.max(0, food.nutrition() - Math.max(0, hungerGap));
				if (HEALING_FOODS.contains(food.id())) score += health <= HEALING_FOOD_HEALTH ? 1_000.0D : -500.0D;
				else if (LAST_RESORT_FOODS.contains(food.id())) score -= 1_000.0D;
				if (index == 9) score += 0.01D;
				if (score > bestScore) {
					bestScore = score;
					best = index;
				}
			}
			return best;
		}

		private static boolean anyFood(ServerPlayer player) {
			for (int index = 0; index < 9; index++) {
				if (player.getInventory().getItem(index).get(DataComponents.FOOD) != null) return true;
			}
			return player.getOffhandItem().get(DataComponents.FOOD) != null;
		}
	}

	/**
	 * Pick the slot with the named item or the best tool of a kind ("any": the kind that just broke). In the hotbar it is
	 * one number key; in the main inventory the screen opens, the stack is swapped into the hotbar with its number key,
	 * and the screen closes, paced as a player does it (the body stands still while the screen is open). A tool at or
	 * below a holding tool_low threshold is not a replacement.
	 */
	static final class Select implements Behaviour {
		/** Same pacing as the select_tool transaction: the screen is shown 2 ticks before the swap and 2 after. */
		static final int OPEN_TICKS = 2;
		static final int LINGER_TICKS = 2;
		private final String tool;
		private final String item;
		private int ticks;
		private int source = -1;
		private int hotbar = -1;
		private boolean screen;
		private String swapped;

		Select(String tool, String item) {
			this.tool = tool;
			this.item = item;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			ticks++;
			if (screen) return paced(player, input);
			String kind = "any".equals(tool) ? context.memory().brokeKind() : tool;
			if (item == null && kind == null) return Step.failed("no tool has broken yet to match");
			String preferred = "any".equals(tool) || tool != null && tool.equals(context.memory().brokeKind()) ? context.memory().brokeItem() : null;
			int low = item == null ? context.memory().lowUses() : -1;
			int best = best(player, kind, preferred, low, 0, 9);
			String wanted = item != null ? item : kind;
			if (best >= 0) {
				input.accept(still(player, best));
				return Step.done("selected " + id(player.getInventory().getItem(best)) + " in slot " + best);
			}
			int stored = best(player, kind, preferred, low, 9, 36);
			if (stored < 0) return Step.failed("no " + wanted + (low >= 0 ? " with more than " + low + " uses left" : "") + " in inventory");
			if (player.containerMenu != player.inventoryMenu) return Step.failed("a container screen is open; " + wanted + " is in the main inventory");
			if (!player.inventoryMenu.getCarried().isEmpty()) return Step.failed("a stack is held on the cursor");
			source = stored;
			hotbar = hotbarFor(player, kind, low);
			screen = true;
			ticks = 0;
			AgentInventoryView.open(player);
			input.accept(still(player, player.getInventory().getSelectedSlot()));
			return Step.running("opening inventory for " + id(player.getInventory().getItem(source)));
		}

		private Step paced(ServerPlayer player, Consumer<AgentInputState> input) {
			if (swapped == null) {
				if (ticks < OPEN_TICKS) {
					input.accept(still(player, player.getInventory().getSelectedSlot()));
					return Step.running("inventory open");
				}
				String moving = id(player.getInventory().getItem(source));
				var refused = AdvancedInteractionService.swapIntoHotbar(player, source, hotbar);
				if (refused != null) {
					end(player);
					return Step.failed("swap refused: " + refused.message());
				}
				swapped = moving;
				ticks = 0;
			}
			input.accept(still(player, hotbar));
			if (ticks < LINGER_TICKS) return Step.running("swapped " + swapped + " into slot " + hotbar);
			end(player);
			return Step.done("moved " + swapped + " from inventory slot " + source + " to hotbar " + hotbar + " and selected it");
		}

		@Override
		public void end(ServerPlayer player) {
			if (screen && AgentInventoryView.isOpen(player)) AgentInventoryView.close(player);
			screen = false;
		}

		private int best(ServerPlayer player, String kind, String preferred, int low, int from, int to) {
			int best = -1;
			double score = Double.NEGATIVE_INFINITY;
			for (int index = from; index < to; index++) {
				ItemStack stack = player.getInventory().getItem(index);
				if (!matches(stack, kind) || low >= 0 && stack.isDamageableItem() && stack.getMaxDamage() - stack.getDamageValue() <= low) continue;
				double value = rank(stack, kind) + (preferred != null && preferred.equals(id(stack)) ? 1_000.0D : 0.0D);
				if (value > score) {
					score = value;
					best = index;
				}
			}
			return best;
		}

		/**
		 * The hotbar slot the stack goes to: the held slot when it is empty or holds the worn tool being replaced (the
		 * worn one goes back into the inventory), else an empty hotbar slot, else the held slot.
		 */
		private static int hotbarFor(ServerPlayer player, String kind, int low) {
			int selected = player.getInventory().getSelectedSlot();
			ItemStack held = player.getInventory().getItem(selected);
			if (held.isEmpty() || low >= 0 && kind != null && kind.equals(ReflexSensors.toolKind(held))) return selected;
			for (int index = 0; index < 9; index++) if (player.getInventory().getItem(index).isEmpty()) return index;
			return selected;
		}

		private static AgentInputState still(ServerPlayer player, int slot) {
			return new AgentInputState(0.0F, 0.0F, false, false, false, false, false,
					player.getYRot(), player.getXRot(), slot, InteractionHand.MAIN_HAND);
		}

		private boolean matches(ItemStack stack, String kind) {
			if (stack.isEmpty()) return false;
			return item != null ? item.equals(id(stack)) : kind.equals(ReflexSensors.toolKind(stack));
		}

		private static double rank(ItemStack stack, String kind) {
			if (kind == null) return 0.0D;
			return switch (kind) {
				case "pickaxe" -> stack.getDestroySpeed(Blocks.STONE.defaultBlockState());
				case "axe" -> stack.getDestroySpeed(Blocks.OAK_LOG.defaultBlockState());
				case "shovel" -> stack.getDestroySpeed(Blocks.DIRT.defaultBlockState());
				case "hoe" -> stack.getDestroySpeed(Blocks.HAY_BLOCK.defaultBlockState());
				default -> stack.getMaxDamage();
			};
		}

		@Override
		public boolean keepsSelection() { return true; }
	}

	/**
	 * Walk to a dropped item a few blocks away (the focus of item_nearby, else the nearest one in view) and let vanilla
	 * pick it up on contact. A short straight walk over known safe footing, jumping a one-block step; anything farther or
	 * blocked fails back to the program.
	 */
	static final class Pickup implements Behaviour {
		private final double within;
		private ItemEntity target;
		private ItemStack identity;
		private int before;
		private int ticks;
		private double bestDistance = Double.POSITIVE_INFINITY;
		private int stalled;

		Pickup(double within) {
			this.within = within;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (target == null) {
				target = context.focus() instanceof ItemEntity focused ? focused : nearest(player);
				if (target == null) return Step.failed("no dropped item in view within " + trim(within) + " blocks");
				identity = target.getItem().copy();
				before = count(player, identity);
			}
			ticks++;
			int now = count(player, identity);
			if (now > before) return Step.done("picked up " + (now - before) + " " + id(identity));
			if (!target.isAlive() || target.getItem().isEmpty()) return Step.failed(id(identity) + " is gone (picked up by something else or despawned)");
			if (!InventoryRoom.canTake(player, target.getItem())) return Step.failed("inventory full for " + id(identity));
			double distance = Math.hypot(target.getX() - player.getX(), target.getZ() - player.getZ());
			if (distance > within + 1.0D) return Step.failed(id(identity) + " moved out of reach (" + String.format(Locale.ROOT, "%.1f", distance) + " blocks)");
			if (distance + 0.05D < bestDistance) {
				bestDistance = distance;
				stalled = 0;
			} else if (++stalled >= 20) {
				return Step.failed("blocked walking to " + id(identity));
			}
			Vec3 delta = target.position().subtract(player.position());
			float heading = Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-delta.x, delta.z)));
			boolean close = distance < 0.6D;
			if (!close && !SafeStep.canStep(player, heading)) return Step.failed("no safe footing toward " + id(identity));
			AgentInputState aim = look(player, target.position(), 0.0F, 0.0F, false, false, player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND);
			float relative = (float) Math.toRadians(AgentInputStates.shortestAngleDelta(aim.yaw(), heading));
			float forward = close ? 0.0F : Mth.clamp((float) Math.cos(relative), -1.0F, 1.0F);
			float strafe = close ? 0.0F : Mth.clamp(-(float) Math.sin(relative), -1.0F, 1.0F);
			boolean jump = player.horizontalCollision && player.onGround() && target.getY() > player.getY() + 0.5D;
			input.accept(new AgentInputState(forward, strafe, jump, false, false, false, false, aim.yaw(), aim.pitch(), aim.selectedSlot(), aim.hand()));
			return Step.running(String.format(Locale.ROOT, "walking to %s %.1f blocks", id(identity), distance));
		}

		private ItemEntity nearest(ServerPlayer player) {
			var frame = dev.agaminggod.mineagen.server.perception.ObservationVisibility.frame(player.level(), player);
			ItemEntity best = null;
			double bestDistance = Double.POSITIVE_INFINITY;
			for (ItemEntity item : player.level().getEntitiesOfClass(ItemEntity.class, player.getBoundingBox().inflate(within), ItemEntity::isAlive)) {
				double distance = player.distanceTo(item);
				if (distance > within || distance >= bestDistance || !InventoryRoom.canTake(player, item.getItem()) || !frame.canSeeEntity(item)) continue;
				bestDistance = distance;
				best = item;
			}
			return best;
		}

		private static int count(ServerPlayer player, ItemStack identity) {
			int count = 0;
			for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (!stack.isEmpty() && ItemStack.isSameItemSameComponents(stack, identity)) count += stack.getCount();
			}
			return count;
		}
	}

	/**
	 * The owed-drops habit (issue #2, 1b): walk to the drops a kill left behind (a hostile was near when the fight ended,
	 * or the model moved on) by pick_up_item's own route, throwing junk for room, for at most {@link #COLLECT_MS}, then
	 * walk back to where the body stood. Each drop is tried once. A hostile coming near stops the collecting and the body
	 * walks back. It always ends DONE with what it picked up and left: an empty pass is not a failure, so a run of them
	 * never switches the rule off. drops_owed holds only for an idle body, so it never pauses the agent's own action.
	 */
	static final class CollectDrops implements Behaviour {
		static final long COLLECT_MS = 12_000L;
		static final long BACK_MS = 7_000L;
		private dev.agaminggod.mineagen.server.runtime.controller.KillDropCollector collector;
		private ServerNavigationController back;
		private Vec3 start;
		private String summary;
		private String finished;
		private boolean underFire;

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			long now = dev.agaminggod.mineagen.server.runtime.GameClock.nowMs();
			if (start == null) {
				List<java.util.UUID> owed = dev.agaminggod.mineagen.server.perception.ObservedDrops.owed(player, ReflexSensors.OWED_WITHIN);
				if (owed.isEmpty()) return Step.done("no owed drop left");
				dev.agaminggod.mineagen.server.perception.ObservedDrops.tried(player, owed);
				start = player.position();
				// The body's own kill loot, as the pickup reflex takes items; room is made from junk only.
				collector = new dev.agaminggod.mineagen.server.runtime.controller.KillDropCollector(owed, null, now, COLLECT_MS)
						.makingRoom(ignored -> true);
			}
			if (collector != null) {
				String blocker = dev.agaminggod.mineagen.server.runtime.controller.KillDropCollector.hostileNear(player);
				String done = blocker != null ? "stopped, " + blocker : collector.tick(player, now);
				if (done == null) return Step.running("collecting owed drops");
				if (blocker != null) { collector.cancel(player); underFire = true; }
				collector = null;
				summary = tally(done);
				if (player.position().distanceTo(start) <= 1.0D) return finish("owed drops: " + summary);
				back = new ServerNavigationController(start, 0.6D, false, now, BACK_MS, false);
			}
			return walkBack(player, now);
		}

		/**
		 * The walk back to where the pass started. The engine reads a new firing's first-tick status only on its next
		 * tick, so a pass that already finished (at its start, nothing to walk) gives its done step again.
		 */
		Step walkBack(ServerPlayer player, long now) {
			if (back == null) return Step.done(finished == null ? "owed drops: " + summary : finished);
			var walked = back.tick(player, now);
			if (walked.state() == dev.agaminggod.mineagen.server.runtime.controller.ServerController.State.RUNNING) return Step.running("walking back from owed drops");
			back.cancel(player);
			back = null;
			return finish("owed drops: " + summary + (walked.state() == dev.agaminggod.mineagen.server.runtime.controller.ServerController.State.SUCCEEDED
					? (underFire ? "; walked back under fire" : "; walked back") : "; walk back " + walked.reasonCode()));
		}

		private Step finish(String detail) {
			finished = detail;
			return Step.done(detail);
		}

		/** A pass whose collection already finished where it started, as after its first tick (for tests). */
		static CollectDrops finishedInPlace(String summary) {
			CollectDrops pass = new CollectDrops();
			pass.start = Vec3.ZERO;
			pass.summary = summary;
			pass.finished = "owed drops: " + summary;
			return pass;
		}

		/**
		 * The collector's notes as counts, so the firing detail (cut at 160 characters) keeps its outcome: "picked up 2,
		 * left 1, made room" with the first reason a drop was left, or the collector's own line when it has no notes.
		 */
		static String tally(String notes) {
			int picked = 0, left = 0;
			boolean room = false;
			String firstLeft = null;
			for (String note : notes.split("; ")) {
				if (note.startsWith("picked up")) picked++;
				else if (note.startsWith("left ")) { left++; if (firstLeft == null) firstLeft = note.substring(note.lastIndexOf(':') + 1).trim(); }
				else if (note.startsWith("made room")) room = true;
			}
			if (picked == 0 && left == 0) return notes.length() > 80 ? notes.substring(0, 80) : notes;
			return "picked up " + picked + ", left " + left + (room ? ", made room" : "") + (firstLeft == null ? "" : " (" + (firstLeft.length() > 50 ? firstLeft.substring(0, 50) : firstLeft) + ")");
		}

		@Override
		public void end(ServerPlayer player) {
			if (collector != null) collector.cancel(player);
			collector = null;
			if (back != null) back.cancel(player);
			back = null;
		}

		@Override
		public boolean drivesOwnNavigation() { return true; }
	}

	/**
	 * Place the named item from the hotbar or offhand, with a player's right click on a face in reach: {@code below} the
	 * feet (a block under a gap, a torch at the feet, water under a fall once the ground is in reach) or {@code ahead}
	 * (the feet-level cell in front of the view: a block into flowing water or a hole, a torch on the floor). The view
	 * turns at player speed and the click lands only when the crosshair is on that face.
	 */
	static final class Place implements Behaviour {
		/** Ticks of horizontal motion a fall clutch leads its aim by: the body moves on between the click and the landing. */
		static final double CLUTCH_LEAD_TICKS = 2.0D;
		private final String item;
		private final String where;
		private int ticks;
		/** The water source a fall clutch placed, while the body lands and scoops it back. */
		private BlockPos placedWater;
		private InteractionHand placedHand;
		private int placedSlot;
		private int landedTicks;

		Place(String item, String where) {
			this.item = item;
			this.where = where;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			ticks++;
			if (placedWater != null) return scoop(player, input);
			InteractionHand hand;
			int slot = player.getInventory().getSelectedSlot();
			if (item.equals(id(player.getOffhandItem()))) hand = InteractionHand.OFF_HAND;
			else {
				hand = InteractionHand.MAIN_HAND;
				slot = -1;
				for (int index = 0; index < 9; index++) if (item.equals(id(player.getInventory().getItem(index)))) {
					slot = index;
					if (index == player.getInventory().getSelectedSlot()) break;
				}
				if (slot < 0) return Step.failed("no " + item + " in hotbar or offhand");
			}
			boolean bucket = (hand == InteractionHand.OFF_HAND ? player.getOffhandItem() : player.getInventory().getItem(slot)).getItem() instanceof net.minecraft.world.item.BucketItem;
			Level level = player.level();
			BlockPos feet = player.blockPosition();
			BlockHitResult crosshair;
			if (bucket && "below".equals(where) && !player.onGround() && !player.isInWater()) {
				Vec3 motion = player.getDeltaMovement();
				Vec3 landing = player.getEyePosition().add(motion.x * CLUTCH_LEAD_TICKS, -4.0D, motion.z * CLUTCH_LEAD_TICKS);
				input.accept(look(player, landing, 0.0F, 0.0F, false, false, slot, hand));
				if (player.getInventory().getSelectedSlot() != slot && hand == InteractionHand.MAIN_HAND) return Step.running("selecting " + item);
				crosshair = level.clip(new ClipContext(player.getEyePosition(), player.getEyePosition().add(player.getLookAngle().scale(player.blockInteractionRange())),
						ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
				if (crosshair.getType() != HitResult.Type.BLOCK || crosshair.getDirection() != Direction.UP
						|| !level.getBlockState(crosshair.getBlockPos().above()).canBeReplaced()) {
					return Step.running("falling; ground not in reach yet");
				}
			} else {
				// feet: a bucket empties on the ground under you and the water stays, the puddle a player stands in against endermen.
				Click click = bucket && ("below".equals(where) || "feet".equals(where)) ? waterBelow(player) : target(player, level, feet, bucket);
				if (click == null) return Step.failed("nothing to place against " + where);
				AgentInputState aim = look(player, click.point(), 0.0F, 0.0F, false, false, slot, hand);
				input.accept(aim);
				if (player.getInventory().getSelectedSlot() != slot && hand == InteractionHand.MAIN_HAND) return Step.running("selecting " + item);
				crosshair = level.clip(new ClipContext(player.getEyePosition(), player.getEyePosition().add(player.getLookAngle().scale(player.blockInteractionRange())),
						ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
				if (crosshair.getType() != HitResult.Type.BLOCK || !crosshair.getBlockPos().equals(click.against()) || crosshair.getDirection() != click.face()) {
					return ticks > 20 ? Step.failed("could not aim at the " + where + " face") : Step.running("aiming " + where);
				}
			}
			ItemStack held = player.getItemInHand(hand);
			int count = held.getCount();
			InteractionResult result = player.gameMode.useItemOn(player, level, held, hand, crosshair);
			if (!result.consumesAction() && !(result instanceof InteractionResult.Fail)) result = player.gameMode.useItem(player, level, held, hand);
			if (!result.consumesAction()) return Step.failed("the click on the " + where + " face was refused");
			ArmSwing.use(player, hand);
			boolean used = player.getItemInHand(hand).getCount() < count || !item.equals(id(player.getItemInHand(hand))) || player.isCreative();
			if (used && bucket && "below".equals(where) && level.getFluidState(crosshair.getBlockPos().above()).isSourceOfType(net.minecraft.world.level.material.Fluids.WATER)) {
				placedWater = crosshair.getBlockPos().above();
				placedHand = hand;
				placedSlot = hand == InteractionHand.MAIN_HAND ? slot : player.getInventory().getSelectedSlot();
				return Step.running("placed " + item + " below; landing");
			}
			if (used && bucket && "feet".equals(where)) {
				BlockPos source = crosshair.getBlockPos().above();
				return Step.done("placed " + item + " at feet " + source.getX() + "," + source.getY() + "," + source.getZ() + "; the source stays until scooped");
			}
			return used ? Step.done("placed " + item + " " + where) : Step.failed("click accepted but nothing was placed");
		}

		/** After a water clutch: once the body has landed, use the emptied bucket on the source to take it back. */
		private Step scoop(ServerPlayer player, Consumer<AgentInputState> input) {
			Level level = player.level();
			if (!level.getFluidState(placedWater).isSourceOfType(net.minecraft.world.level.material.Fluids.WATER)) {
				return Step.done("placed water below; the source is gone");
			}
			if (!player.onGround() && !player.isInWater()) {
				return ticks > 60 ? Step.done("placed water below; still airborne") : Step.running("landing in the placed water");
			}
			if (++landedTicks > 30) return Step.done("placed water below and landed; could not scoop it back");
			ItemStack held = player.getItemInHand(placedHand);
			if (!held.is(net.minecraft.world.item.Items.BUCKET)) return Step.done("placed water below and landed; no empty bucket in hand to scoop it back");
			Vec3 centre = Vec3.atCenterOf(placedWater);
			input.accept(look(player, centre, 0.0F, 0.0F, false, false, placedSlot, placedHand));
			BlockHitResult sight = level.clip(new ClipContext(player.getEyePosition(), player.getEyePosition().add(player.getLookAngle().scale(player.blockInteractionRange())),
					ClipContext.Block.OUTLINE, ClipContext.Fluid.SOURCE_ONLY, player));
			if (sight.getType() != HitResult.Type.BLOCK || !sight.getBlockPos().equals(placedWater)) return Step.running("landed; aiming at the placed water");
			InteractionResult result = player.gameMode.useItem(player, level, held, placedHand);
			if (result.consumesAction() && player.getItemInHand(placedHand).is(net.minecraft.world.item.Items.WATER_BUCKET)) {
				ArmSwing.use(player, placedHand);
				return Step.done("placed water below, landed and scooped it back");
			}
			return Step.running("landed; scooping the placed water");
		}

		private record Click(BlockPos against, Direction face, Vec3 point) {
		}

		/** The face to click so the item lands in the target cell, or null when nothing solid is beside it in reach. */
		private Click target(ServerPlayer player, Level level, BlockPos feet, boolean bucket) {
			BlockPos cell;
			if (!"ahead".equals(where)) {
				BlockPos under = feet.below();
				// Standing on something: the item goes at the feet on its top (a torch); over a gap: into the gap.
				cell = level.getBlockState(under).canBeReplaced() ? under : feet;
			} else {
				Direction facing = player.getDirection();
				cell = feet.relative(facing);
			}
			if (!level.getBlockState(cell).canBeReplaced()) return null;
			Direction[] order = {Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST, Direction.UP};
			for (Direction side : order) {
				BlockPos against = cell.relative(side);
				var state = level.getBlockState(against);
				if (state.canBeReplaced() || state.getCollisionShape(level, against).isEmpty()) continue;
				Direction face = side.getOpposite();
				Vec3 point = Vec3.atCenterOf(against).add(Vec3.atLowerCornerOf(face.getUnitVec3i()).scale(0.5D));
				if (point.distanceTo(player.getEyePosition()) > player.blockInteractionRange()) continue;
				if (bucket) return new Click(against, face, point);
				return new Click(against, face, point);
			}
			return null;
		}

		/** Water under a fall: the first solid top face straight down within reach. */
		private static Click waterBelow(ServerPlayer player) {
			Level level = player.level();
			Vec3 eye = player.getEyePosition();
			BlockHitResult hit = level.clip(new ClipContext(eye, eye.add(0.0D, -player.blockInteractionRange(), 0.0D), ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, player));
			if (hit.getType() != HitResult.Type.BLOCK || hit.getDirection() != Direction.UP) return null;
			return new Click(hit.getBlockPos(), Direction.UP, Vec3.atCenterOf(hit.getBlockPos()).add(0.0D, 0.5D, 0.0D));
		}
	}

	/**
	 * Stop where you are: the body holds still (the paused action does not resume) until the coordinator, seeing this
	 * firing, has cancelled the running program or action; then the firing ends and wakes the model.
	 */
	static final class Stop implements Behaviour {
		private int ticks;
		private boolean running;

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			ticks++;
			if (ticks == 1) running = context.memory().actionActive();
			if (ticks > 1 && !context.memory().actionActive()) return Step.done(running ? "stopped the running action" : "stopped (nothing was running)");
			input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, false, false,
					player.getYRot(), player.getXRot(), player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return Step.running("holding still; stopping the running work");
		}
	}

	private static String trim(double value) {
		return value == Math.rint(value) ? Long.toString((long) value) : Double.toString(value);
	}

	/**
	 * Swim to air until the eyes are out of the water for half a second: along the route to the nearest breathable cell
	 * the player has seen (the observation's {@code breathable}), which is straight up under open water and around the
	 * ceiling of a flooded tunnel. With no seen air under a seen ceiling, duck out into the open water beside it looking
	 * up (travel's PEEK step, WaterAirFacts.peekCell), so the way up beside the ledge comes into view; with neither,
	 * hold jump with the view tilted up.
	 */
	static final class SwimUp implements Behaviour {
		private boolean wasInWater;
		private int surfacedTicks;
		private int ticks;
		private int peekTicks;
		private final SwimAirProgress progress = new SwimAirProgress();

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			boolean inWater = player.isInWater() || player.isUnderWater();
			if (inWater) wasInWater = true;
			if (!wasInWater) return Step.failed("not in water");
			surfacedTicks = player.isUnderWater() ? 0 : surfacedTicks + 1;
			if (surfacedTicks >= 10 || !inWater) return Step.done("surfaced");
			ticks++;
			var surface = airRoute(player);
			BlockPos peek = surface == null && peekTicks < WaterAirFacts.PEEK_TICKS ? WaterAirFacts.peekCell(player) : null;
			switch (swimUpStep(surface != null, peek != null, peekTicks)) {
				case DUCK_OUT -> {
					peekTicks++;
					input.accept(duckOut(player, peek));
					return Step.running("ducking out from under the ceiling to " + peek.toShortString());
				}
				case BLIND -> {
					input.accept(riseBlind(player));
					return Step.running("swimming up");
				}
				case ROUTE -> { }
			}
			BlockPos nextDestination = new BlockPos(surface.x(), surface.openY(), surface.z());
			double left = SwimAirProgress.remaining(player.getEyePosition(), surface.path());
			if (progress.stalled(nextDestination, left, ticks)) {
				return Step.failed(String.format(Locale.ROOT, "no progress swimming to air at %d,%d,%d (%.1f blocks left)",
						surface.x(), surface.openY(), surface.z(), left));
			}
			input.accept(swimToAir(player, surface));
			return Step.running(String.format(Locale.ROOT, "swimming to air at %d,%d,%d, %.1f blocks", surface.x(), surface.openY(), surface.z(), left));
		}
	}

	/** What the swim-up does this tick: along the seen route to air, out from under a capped head, or a blind rise. */
	enum SwimUpStep { ROUTE, DUCK_OUT, BLIND }

	/**
	 * A seen route to air comes first. With none and the head capped by a seen block beside a seen open cell
	 * ({@code peek}, WaterAirFacts.peekCell), duck out into that cell for up to WaterAirFacts.PEEK_TICKS: rising blind
	 * under a ledge only presses the head into it until the air runs out. Otherwise rise blind.
	 */
	static SwimUpStep swimUpStep(boolean route, boolean peek, int peekTicks) {
		if (route) return SwimUpStep.ROUTE;
		return peek && peekTicks < WaterAirFacts.PEEK_TICKS ? SwimUpStep.DUCK_OUT : SwimUpStep.BLIND;
	}

	/** The route to the nearest breathable cell the player has seen, while the eyes are under water; null when none is known. */
	static dev.agaminggod.mineagen.server.runtime.controller.SwimPlanning.Surface airRoute(ServerPlayer player) {
		var surface = player.isUnderWater() ? WaterAirFacts.surface(player).surface() : null;
		return surface == null || surface.path().size() < 2 ? null : surface;
	}

	/**
	 * Under a seen ceiling with no way up known: swim into the open cell beside it looking nearly straight up, holding jump,
	 * as travel's PEEK step does. Not sprinting: a sprint-swim follows the view, which points up into the ceiling.
	 */
	static AgentInputState duckOut(ServerPlayer player, BlockPos peek) {
		float heading = Mth.wrapDegrees(WaterAirFacts.peekYaw(player, peek));
		float yaw = AgentInputStates.turnYaw(player.getYRot(), heading);
		float pitch = AgentInputStates.turnPitch(player.getXRot(), WaterAirFacts.PEEK_PITCH);
		float forward = CombatPlanning.alignedForward(1.0F, AgentInputStates.shortestAngleDelta(yaw, heading));
		return new AgentInputState(forward, 0.0F, true, false, false, false, false, yaw, pitch,
				player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND);
	}

	/** No air seen: hold jump with the view tilted up, as a player rises blind. */
	static AgentInputState riseBlind(ServerPlayer player) {
		float pitch = AgentInputStates.turnPitch(player.getXRot(), -45.0F);
		return new AgentInputState(0.0F, 0.0F, true, false, false, false, false, player.getYRot(), pitch,
				player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND);
	}

	/** One tick of swimming along {@code surface}'s route: aim at the next cell (the path starts at the eye cell), rising to it. */
	static AgentInputState swimToAir(ServerPlayer player, dev.agaminggod.mineagen.server.runtime.controller.SwimPlanning.Surface surface) {
		Vec3 eye = player.getEyePosition();
		BlockPos next = surface.path().get(1);
		Vec3 target = new Vec3(next.getX() + 0.5D, Math.max(next.getY() + 0.25D, eye.y), next.getZ() + 0.5D);
		double dx = target.x - eye.x, dz = target.z - eye.z;
		boolean across = dx * dx + dz * dz > 0.04D;
		float heading = across ? Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz))) : player.getYRot();
		float yaw = AgentInputStates.turnYaw(player.getYRot(), heading);
		float pitch = AgentInputStates.turnPitch(player.getXRot(), target.y > eye.y + 0.05D ? SwimPlanning.SURFACING_PITCH : 0.0F);
		float forward = across ? CombatPlanning.alignedForward(1.0F, AgentInputStates.shortestAngleDelta(yaw, heading)) : 0.0F;
		boolean sprint = SwimPlanning.swimSprint(true, true, forward, player.getFoodData().getFoodLevel());
		return new AgentInputState(forward, 0.0F, true, false, sprint, false, false, yaw, pitch,
				player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND);
	}

	/**
	 * Punch a fireball back, as a player does: aim at it and swing when the crosshair is on it inside entity reach.
	 * Vanilla sends only {@code #redirectable_projectile} (ghast fireballs, wind charges) back along the view; the hit
	 * makes the player its owner, which ends the firing.
	 */
	static final class Deflect implements Behaviour {
		private int swings;

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			Entity focus = context.focus();
			if (!(focus instanceof Projectile projectile) || !projectile.isAlive()) {
				return swings > 0 ? Step.done("deflected the fireball") : Step.failed("no fireball to deflect");
			}
			if (projectile.getOwner() == player) return Step.done("deflected " + type(projectile));
			if (!ReflexSensors.redirectable(projectile)) return Step.failed(type(projectile) + " cannot be deflected; shield or dodge it");
			// Lead by one tick: the view lands where the fireball will be when the swing resolves.
			Vec3 aim = projectile.getBoundingBox().getCenter().add(projectile.getDeltaMovement());
			input.accept(look(player, aim, 0.0F, 0.0F, false, false, player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			double reach = player.entityInteractionRange();
			if (!player.isUsingItem() && Tracer.rayTrace(player, 1.0F, reach, false) instanceof EntityHitResult hit && hit.getEntity() == projectile) {
				player.attack(projectile);
				ArmSwing.attack(player, InteractionHand.MAIN_HAND);
				player.resetAttackStrengthTicker();
				player.resetLastActionTime();
				swings++;
			}
			return Step.running(swings == 0 ? "tracking fireball" : "swung " + swings + "x");
		}

		@Override
		public boolean holdsWhileTrue() { return true; }
	}

	/** How far a fallback threat (a condition that names no mob, such as low health) is looked for. */
	static final double WATCHER_RANGE = 24.0D;

	/** Hostile mobs within range that can see the player (they can shoot or charge it), nearest first. */
	static List<Mob> watchers(ServerPlayer player) {
		List<Mob> mobs = new ArrayList<>(player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(WATCHER_RANGE),
				mob -> mob.isAlive() && ThreatPerception.isHostileTo(mob, player) && !mob.isInvisibleTo(player)
						&& player.distanceTo(mob) <= WATCHER_RANGE && mob.hasLineOfSight(player)));
		mobs.sort(java.util.Comparator.comparingDouble(player::distanceTo));
		return mobs;
	}

	/** How far round the body the mobs of a pack are counted when a run picks its way out of it. */
	static final double PACK_RANGE = 8.0D;

	/** Hostile pack members ({@link #packMember}) within {@code within} blocks and in the body's sight, nearest first. */
	static List<Mob> meleeNear(ServerPlayer player, double within) {
		List<Mob> mobs = new ArrayList<>(player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(within),
				mob -> mob.isAlive() && ThreatPerception.isHostileTo(mob, player) && !mob.isInvisibleTo(player) && packMember(mob, player)
						&& player.distanceTo(mob) <= within && player.hasLineOfSight(mob)));
		mobs.sort(java.util.Comparator.comparingDouble(player::distanceTo));
		return mobs;
	}

	/** A melee mob after the body this close (centre to centre) lands its first hit in one to two seconds. */
	static final double CLOSING_RANGE = 5.0D;

	static Mob closingMelee(ServerPlayer player) {
		Mob nearest = null;
		double best = Double.POSITIVE_INFINITY;
		for (Mob mob : player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(CLOSING_RANGE),
				mob -> mob.isAlive() && mob.getTarget() == player && !mob.isInvisibleTo(player) && packMember(mob, player))) {
			double distance = player.distanceTo(mob);
			if (distance > CLOSING_RANGE || distance >= best || !player.hasLineOfSight(mob)) continue;
			best = distance;
			nearest = mob;
		}
		return nearest;
	}

	/** A pack member's own hit, before the body's armour, must be at least this (a heart) for running from the pack to pay. */
	static final double PACK_HIT = 2.0D;

	static boolean packMember(Mob mob, ServerPlayer player) {
		if (ThreatPerception.isRanged(mob) || mob instanceof net.minecraft.world.entity.monster.Guardian
				|| mob instanceof net.minecraft.world.entity.monster.Shulker || mob instanceof net.minecraft.world.entity.monster.breeze.Breeze
				|| mob instanceof net.minecraft.world.entity.monster.illager.SpellcasterIllager) return false;
		if (mob.isNoGravity() || mob instanceof net.minecraft.world.entity.monster.Phantom) return false;
		return "melee".equals(ThreatDamage.expectedHit(mob, player).mode()) && ThreatDamage.meleeHitBeforeDefences(mob, player) >= PACK_HIT;
	}

	/** How near a cell's centre a pack member stands for a retreat to refuse that cell: it would run into the mob. */
	static final double PACK_CELL_RADIUS = 1.5D;

	/** A pack member ({@link #packMember}) hostile to the body stands on or beside {@code cell}. */
	static boolean packOnCell(ServerPlayer player, GridPosition cell) {
		double x = cell.x() + 0.5D, z = cell.z() + 0.5D;
		return !player.level().getEntitiesOfClass(Mob.class, new AABB(x - 2.0D, cell.y() - 2.0D, z - 2.0D, x + 2.0D, cell.y() + 3.0D, z + 2.0D),
				mob -> mob.isAlive() && ThreatPerception.isHostileTo(mob, player) && packMember(mob, player)
						&& Math.hypot(mob.getX() - x, mob.getZ() - z) <= PACK_CELL_RADIUS && Math.abs(mob.getY() - cell.y()) < 2.0D).isEmpty();
	}

	/**
	 * Where a pack presses from: its mobs' positions weighted by 1/distance squared, so the nearest count most and a run
	 * leaves all of them behind instead of only the one it was told about (gate B7: a retreat from 4 zombies switched
	 * between them and ran S, SW, W, NE, SE for 4 s, ending 3.8 blocks away). Null with fewer than two.
	 */
	static Vec3 packCentre(ServerPlayer player, List<Mob> pack) {
		if (pack.size() < 2) return null;
		double x = 0.0D, z = 0.0D, total = 0.0D;
		for (Mob mob : pack) {
			double weight = 1.0D / Math.max(0.25D, player.distanceToSqr(mob));
			x += mob.getX() * weight;
			z += mob.getZ() * weight;
			total += weight;
		}
		return new Vec3(x / total, player.getY(), z / total);
	}

	/** Sprinting needs food above 6, as for a player. */
	private static boolean canSprint(ServerPlayer player) {
		return player.getFoodData().getFoodLevel() > 6 || player.getAbilities().mayfly;
	}

	/** Walk the body toward a cell centre: face it, press forward when facing it, jump a step up, sprint if asked. */
	private static AgentInputState walkToward(ServerPlayer player, GridPosition cell, boolean sprint, boolean separateAim) {
		Vec3 centre = new Vec3(cell.x() + 0.5D, player.getEyeY(), cell.z() + 0.5D);
		AgentInputState aim = look(player, centre, 0.0F, 0.0F, false, false, player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND);
		float heading = (float) Math.toDegrees(Math.atan2(-(centre.x - player.getX()), centre.z - player.getZ()));
		// The shield owns the view and rotates these keys from the path heading into the final view.
		float movementYaw = separateAim ? heading : aim.yaw();
		float error = AgentInputStates.shortestAngleDelta(movementYaw, heading);
		float forward = CombatPlanning.alignedForward(1.0F, error);
		boolean jump = cell.y() > SafeStep.feet(player).y() && player.onGround() && Math.abs(error) < 30.0F;
		boolean run = sprint && Math.abs(error) < 30.0F && canSprint(player);
		return new AgentInputState(forward, 0.0F, jump, false, run, false, false, movementYaw, aim.pitch(), aim.selectedSlot(), aim.hand());
	}

	/** Follows a short planned path cell by cell; fails when the body stops making ground. */
	static final class PathWalk {
		private final List<GridPosition> path;
		private final double arrivalRadius;
		private int index;
		private Vec3 last;
		private int stuck;

		/** Path cells a seen lava flow already reached when the walk began (it started in the flow's way). */
		private java.util.Set<GridPosition> acceptedFlows;
		private int sinceLavaCheck;
		/** Ticks between checks of the cells ahead for lava that has flowed beside them. */
		static final int LAVA_RECHECK_TICKS = 5;
		/** Cells ahead of the body checked (a flow moves about a cell a second over a floor). */
		static final int LAVA_LOOKAHEAD_CELLS = 6;

		PathWalk(List<GridPosition> path) {
			this(path, 0.4D);
		}

		PathWalk(List<GridPosition> path, double arrivalRadius) {
			this.path = List.copyOf(path);
			this.arrivalRadius = arrivalRadius;
		}

		/**
		 * A cell within the next few that seen lava has flowed into since the walk began, or null; checked every
		 * {@link #LAVA_RECHECK_TICKS} ticks. A player turns away from a flow coming at its path instead of walking on into it.
		 */
		GridPosition lavaAhead(ServerPlayer player) {
			if (acceptedFlows == null) {
				acceptedFlows = SafeStep.lavaFlows(player, path);
				return null;
			}
			if (++sinceLavaCheck < LAVA_RECHECK_TICKS) return null;
			sinceLavaCheck = 0;
			advance(player);
			List<GridPosition> ahead = path.subList(index, Math.min(path.size(), index + LAVA_LOOKAHEAD_CELLS));
			return newFlow(ahead, acceptedFlows, SafeStep.lavaFlows(player, ahead));
		}

		/** The first of {@code ahead} that lava flows into now ({@code flows}) and did not when the walk began. */
		static GridPosition newFlow(List<GridPosition> ahead, java.util.Set<GridPosition> accepted, java.util.Set<GridPosition> flows) {
			for (GridPosition cell : ahead) if (flows.contains(cell) && !accepted.contains(cell)) return cell;
			return null;
		}

		/** A cell within the next {@link #PACK_LOOKAHEAD_CELLS} that a pack member stands on or beside, or null. */
		GridPosition packAhead(ServerPlayer player) {
			advance(player);
			for (GridPosition cell : path.subList(index, Math.min(path.size(), index + PACK_LOOKAHEAD_CELLS))) {
				if (packOnCell(player, cell)) return cell;
			}
			return null;
		}

		static final int PACK_LOOKAHEAD_CELLS = 4;

		/** The cell walked toward now (cells already reached are passed), or null once the last is reached. */
		GridPosition next(ServerPlayer player) {
			advance(player);
			return index < path.size() ? path.get(index) : null;
		}

		private void advance(ServerPlayer player) {
			while (index < path.size()) {
				GridPosition cell = path.get(index);
				double horizontal = Math.hypot(player.getX() - (cell.x() + 0.5D), player.getZ() - (cell.z() + 0.5D));
				if (horizontal > arrivalRadius || Math.abs(player.getY() - cell.y()) > 0.7D) break;
				index++;
			}
		}

		/** RUNNING while walking, DONE on the last cell, FAILED when blocked. */
		Step tick(ServerPlayer player, Consumer<AgentInputState> input, boolean sprint) {
			return tick(player, input, sprint, false, 0.0025D);
		}

		Step tick(ServerPlayer player, Consumer<AgentInputState> input, boolean sprint, boolean separateAim, double minProgressSqr) {
			advance(player);
			if (index >= path.size()) return Step.done("arrived");
			Vec3 now = player.position();
			stuck = last != null && now.distanceToSqr(last) < minProgressSqr ? stuck + 1 : 0;
			last = now;
			GridPosition cell = path.get(index);
			if (stuck >= 30) return Step.failed("blocked on the way at " + cell.x() + "," + cell.y() + "," + cell.z());
			input.accept(walkToward(player, cell, sprint, separateAim));
			return Step.running("moving " + (path.size() - index) + " cell(s) left");
		}
	}

	/** Run from the threat (the focus or the condition's point) along known safe footing, facing where it runs. */
	static final class SprintAway implements Behaviour {
		private static final float[] OFFSETS = {0.0F, 30.0F, -30.0F, 60.0F, -60.0F, 90.0F, -90.0F, 120.0F, -120.0F};
		private static final float[] CREEPER_OFFSETS = {0.0F, 30.0F, -30.0F, 60.0F, -60.0F, 90.0F, -90.0F};
		/** The fuse starts inside three blocks. Once it is out, leave twice that much room before stopping. */
		private static final double CREEPER_CLEAR = 6.0D;
		/** Health a drop taken in place of a level escape must leave. */
		private static final float SURVIVE_MARGIN = 4.0F;
		/** Headings back toward a cloud's centre, tried only when none of {@link #OFFSETS} has footing. */
		private static final float[] BACK_OFFSETS = {150.0F, -150.0F, 180.0F};
		/** One dragon-breath hit (Instant Damage I). */
		private static final int CLOUD_CROSSING_DAMAGE = 6;
		private final double blocks;
		private final int maxDrop;
		private final boolean keepClearOfPack;
		private boolean triedApproach;
		/** One block down, as running over uneven ground steps down; a deeper drop leaves the footing the body stood on. */
		static final int BACK_OUT_DROP = 1;
		private Vec3 start;
		private Vec3 origin;
		private Creeper creeper;
		private double startSeparation = Double.NaN;
		private Vec3 last;
		private int stuck;
		private Float lastHeading;
		private int glanced;
		private final Map<Integer, Integer> glancedAt = new java.util.HashMap<>();
		private Float dropHeading;
		/** Feet height when {@link #dropHeading} was chosen: once the body lands below it the drop is taken. */
		private int dropFromY;
		/** {@link #dropHeading} is the level way back across a cloud, not a drop; {@link #spentAcross} once its footing ran out. */
		private boolean acrossCloud;
		private boolean spentAcross;
		private String dropNote = "";
		/** The run's end, held while the body steps back off a brink first ({@link #settle}). */
		private Step ending;
		private Vec3 settleTo;
		private int settleTicks;
		/** A way back along known walkable cells, taken when no straight heading has safe footing (a tunnel, a bend). */
		private PathWalk walk;
		private String walkNote = "";
		private boolean repathed;
		/** Ticks pressed against something before a straight run turns to the known-ground path. */
		private static final int STUCK_REPATH_TICKS = 6;
		/** Ticks a run's end may spend stepping back off a brink (a crouched step covers about 0.065 blocks a tick). */
		private static final int SETTLE_TICKS = 24;

		SprintAway(double blocks) {
			this(blocks, Integer.MAX_VALUE);
		}

		SprintAway(double blocks, int maxDrop) {
			this(blocks, maxDrop, false);
		}

		SprintAway(double blocks, int maxDrop, boolean keepClearOfPack) {
			this.blocks = blocks;
			this.maxDrop = maxDrop;
			this.keepClearOfPack = keepClearOfPack;
		}

		private boolean keepsFooting() {
			return maxDrop != Integer.MAX_VALUE;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (start == null) start = player.position();
			if (context.focus() instanceof Creeper target && target != creeper
					&& (creeper == null || ReflexSensors.fusing(target))) {
				if (creeper != null || ending != null) retarget(player.position());
				creeper = target;
			}
			if (ending != null) return settle(player, input);
			double moved = Math.hypot(player.getX() - start.x, player.getZ() - start.z);
			// The default sense hands over a lit creeper only within 5 blocks; one lit just beyond is still inside this run's clearance.
			if (creeper != null && (!creeper.isAlive() || !ReflexSensors.fusing(creeper))) {
				Creeper next = otherFusing(player, creeper);
				if (next != null) {
					retarget(player.position());
					creeper = next;
				}
			}
			if (creeper != null && !creeper.isAlive()) {
				return end(player, input, Step.done(String.format(Locale.ROOT, "ran %.1f blocks; creeper is gone", moved)));
			}
			Vec3 threat = context.threat();
			if (creeper != null) threat = creeper.position();
			// From a melee mob with others of its kind about, the run leaves the pack, not the one mob. A fusing creeper, an
			// archer or a place keep their own point: the creeper's blast is the danger whatever else stands near.
			if (context.focus() instanceof Mob mob && !(mob instanceof Creeper) && !ThreatPerception.isRanged(mob)) {
				Vec3 pack = packCentre(player, meleeNear(player, PACK_RANGE));
				if (pack != null) threat = pack;
			}
			if (threat == null && origin == null) {
				// No mob or place in the condition (low health): run from the nearest hostile that sees the player.
				List<Mob> seen = watchers(player);
				if (!seen.isEmpty()) threat = seen.getFirst().position();
			}
			if (threat != null) origin = threat;
			else if (origin == null) origin = player.position().subtract(player.getViewVector(1.0F).multiply(1.0D, 0.0D, 1.0D));
			double separation = Math.hypot(player.getX() - origin.x, player.getZ() - origin.z);
			if (Double.isNaN(startSeparation)) startSeparation = separation;
			boolean fusing = creeper != null && ReflexSensors.fusing(creeper);
			boolean creeperClear = creeper != null && separation >= CREEPER_CLEAR && !fusing;
			boolean ranFarEnough = separation - startSeparation >= blocks || moved >= blocks * 1.5D;
			if (keepClearOfPack) {
				double chaseGap = context.point() == null ? PACK_RANGE : Defend.CHASE_RANGE;
				double nearest = Defend.nearestChaser(player, chaseGap);
				ranFarEnough = nearest >= chaseGap && (ranFarEnough || context.point() != null && separation >= blocks);
			}
			if (creeperClear || ranFarEnough && (!fusing || separation >= CREEPER_CLEAR)) {
				return end(player, input, Step.done(String.format(Locale.ROOT, "ran %.1f blocks, now %.1f away", moved, separation) + dropNote + walkNote));
			}
			if (dropHeading != null && player.onGround() && Mth.floor(player.getY() + 1.0E-4D) < dropFromY) dropHeading = null;
			// The way back across a cloud is a level heading: once its footing ends (the far rim of an End platform) the
			// run ends there rather than carry on into the void, which it did with the heading checked only once.
			if (dropHeading != null && acrossCloud && player.onGround() && SafeStep.blocked(player, dropHeading) != null) {
				dropHeading = null;
				acrossCloud = false;
				spentAcross = true;
			}
			if (player.isUnderWater()) {
				var surface = airRoute(player);
				input.accept(surface == null ? riseBlind(player) : swimToAir(player, surface));
				return Step.running(surface == null ? "surfacing first: swimming up"
						: String.format(Locale.ROOT, "surfacing first: swimming to air at %d,%d,%d", surface.x(), surface.openY(), surface.z()));
			}
			// Lava flowing toward the way back: drop it and pick a heading (the probe refuses the flow's cells).
			if (walk != null && walk.lavaAhead(player) != null) walk = null;
			// A pack member stepped onto the way back (one coming up the entry tunnel): a player turns off rather than run into it.
			if (walk != null && keepClearOfPack && walk.packAhead(player) != null) {
				walk = null;
				walkNote = "";
			}
			if (walk != null) {
				Step step = walk.tick(player, input, canSprint(player));
				if (step.status() == ReflexScheduler.ActionStatus.RUNNING) return Step.running(String.format(Locale.ROOT, "%s, %.1f away", walkNote.substring(2), separation));
				walk = null;
				repathed = false;
				if (step.status() == ReflexScheduler.ActionStatus.FAILED) {
					return Step.failed(String.format(Locale.ROOT, "%s after %.1f blocks", step.detail(), moved));
				}
			}
			if (keepClearOfPack && context.point() != null && !triedApproach) {
				triedApproach = true;
				Step back = walkBack(context, input, separation);
				if (back != null) return back;
			}
			float away = (float) Math.toDegrees(Math.atan2(-(player.getX() - origin.x), player.getZ() - origin.z));
			float[] offsets = creeper == null ? OFFSETS : CREEPER_OFFSETS;
			Float heading = null;
			// Once running away along an edge, keep the heading while it still gains distance and has footing.
			if (creeper != null && lastHeading != null && Math.abs(Mth.wrapDegrees(lastHeading - away)) <= 90.0F
					&& SafeStep.blocked(player, lastHeading) == null && !runsIntoCloud(player, lastHeading)
					&& !runsTowardVoid(player, lastHeading)) heading = lastHeading;
			if (heading == null) heading = SafeStep.heading(player, away, offsets, lastHeading,
					List.of(yaw -> runsIntoCloud(player, yaw) || runsTowardVoid(player, yaw), yaw -> runsTowardVoid(player, yaw)), maxDrop);
			lastHeading = heading;
			if (heading == null && dropHeading != null) heading = dropHeading;
			if (heading == null && spentAcross) return end(player, input, Step.done(String.format(Locale.ROOT, "ran %.1f blocks; no safe heading further", moved) + dropNote + walkNote));
			if (heading == null) {
				// No straight heading keeps footing (a bend in a tunnel, a ledge path): back along cells the player knows it
				// can walk, as a player retraces the way it came.
				Step back = walkBack(context, input, separation);
				if (back != null) return back;
				if (!keepClearOfPack && !fusing && moved >= 1.0D) return end(player, input, Step.done(String.format(Locale.ROOT, "ran %.1f blocks; no safe heading further", moved) + dropNote + walkNote));
				List<SafeStep.Blocked> blocked = new ArrayList<>();
				for (float offset : offsets) {
					SafeStep.Blocked why = SafeStep.blocked(player, Mth.wrapDegrees(away + offset));
					if (why != null) blocked.add(why);
				}
				// Footing the eye has not seen (it faced the threat, or looked up at the dragon): a player turns and looks
				// where it will run before it decides there is nowhere to go.
				// Each unseen heading gets a few ticks of the view; one the eye cannot reach (behind a wall) is not stared at.
				// Unseen ground under a drop deeper than this run may take would not open a way: not looked at.
				SafeStep.Blocked unseen = blocked.stream().filter(why -> why.barrier() == SafeStep.Barrier.UNSEEN && why.drop() <= maxDrop
						&& glancedAt.getOrDefault(Math.round(why.yaw()), 0) < GLANCE_TICKS_EACH).findFirst().orElse(null);
				if (unseen != null && glanced < GLANCE_TICKS) {
					glanced++;
					glancedAt.merge(Math.round(unseen.yaw()), 1, Integer::sum);
					// The headroom a step up needs is above the head: look up for it, else down at the footing.
					float pitch = unseen.at().y() > SafeStep.feet(player).y() + 1 ? -GLANCE_PITCH : GLANCE_PITCH;
					input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, false, false,
							AgentInputStates.turnYaw(player.getYRot(), unseen.yaw()), AgentInputStates.turnPitch(player.getXRot(), pitch),
							player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
					return Step.running("looking at the footing " + SafeStep.compass(unseen.yaw()));
				}
				// Every level heading is a wall, a deep drop or unseen: a player still moves, down the shallowest drop
				// onto known ground that leaves it alive, rather than stand in the cloud or the blast.
				if (keepsFooting()) return Step.failed("no way away without a drop: " + describe(blocked, player));
				SafeStep.Blocked least = null;
				for (SafeStep.Blocked why : blocked) {
					if (why.barrier() != SafeStep.Barrier.DROP || why.fallDamage() > player.getHealth() - SURVIVE_MARGIN) continue;
					if (least == null || why.drop() < least.drop()) least = why;
				}
				// From a cloud (a place, not a mob) the way out can be back across it: one more breath hit, about what a
				// 9-block drop costs; never back past a mob.
				Float across = null;
				if (context.focus() == null && context.point() != null && (least == null || least.fallDamage() > CLOUD_CROSSING_DAMAGE)) {
					for (float offset : BACK_OFFSETS) {
						float yaw = Mth.wrapDegrees(away + offset);
						if (SafeStep.blocked(player, yaw) == null) {
							across = yaw;
							break;
						}
					}
				}
				dropFromY = Mth.floor(player.getY() + 1.0E-4D);
				acrossCloud = across != null;
				if (across != null) {
					dropHeading = across;
					dropNote = "; ran back across the cloud " + SafeStep.compass(across) + ", no other heading away: " + describe(blocked, player);
				} else if (least != null) {
					dropHeading = least.yaw();
					dropNote = String.format(Locale.ROOT, "; dropped %d blocks %s (about %d damage), no level heading away", least.drop(),
							SafeStep.compass(least.yaw()), least.fallDamage());
				} else {
					return Step.failed("no safe heading away: " + describe(blocked, player));
				}
				heading = dropHeading;
			}
			Vec3 now = player.position();
			// Jumping against a corner can change Y without getting anywhere along the retreat.
			if (last != null) {
				Vec3 delta = now.subtract(last);
				double progress = keepClearOfPack || creeper != null ? delta.horizontalDistanceSqr() : delta.lengthSqr();
				stuck = progress < 0.0025D ? stuck + 1 : 0;
			}
			last = now;
			// A straight heading the probe allows can still jam the body on a corner (a diagonal into a side tunnel): a
			// player steps around it along ground it knows rather than push into the corner.
			if (stuck >= STUCK_REPATH_TICKS && !repathed) {
				repathed = true;
				Step back = walkBack(context, input, separation);
				if (back != null) {
					stuck = 0;
					return back;
				}
			}
			if (stuck >= 30) return Step.failed(String.format(Locale.ROOT, "blocked after %.1f blocks running %s", moved, SafeStep.compass(heading)));
			float yaw = AgentInputStates.turnYaw(player.getYRot(), heading);
			float pitch = AgentInputStates.turnPitch(player.getXRot(),
					dev.agaminggod.mineagen.server.runtime.controller.EndermanGaze.clearPitch(player, heading, ServerNavigationController.WALKING_GAZE_PITCH));
			float error = AgentInputStates.shortestAngleDelta(yaw, heading);
			boolean aligned = Math.abs(error) < 30.0F;
			// Swimming on the surface a player holds jump to keep the head out; released, the body sinks as it runs.
			input.accept(new AgentInputState(CombatPlanning.alignedForward(1.0F, error), aligned ? centring(player, yaw) : 0.0F,
					player.isInWater() || aligned && SafeStep.jumpAhead(player, heading), false, aligned && canSprint(player), false, false, yaw, pitch,
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return Step.running(String.format(Locale.ROOT, "running %s, %.1f away", SafeStep.compass(heading), separation));
		}

		/** The nearest lit creeper other than {@code tracked} within {@link #CREEPER_HANDOVER} blocks, or null. */
		static Creeper otherFusing(ServerPlayer player, Creeper tracked) {
			Creeper nearest = null;
			double best = CREEPER_HANDOVER;
			for (Creeper other : player.level().getEntitiesOfClass(Creeper.class, player.getBoundingBox().inflate(CREEPER_HANDOVER),
					other -> other != tracked && other.isAlive() && ReflexSensors.fusing(other))) {
				double distance = player.distanceTo(other);
				if (distance <= best) { best = distance; nearest = other; }
			}
			return nearest;
		}

		/** Vanilla keeps a fuse burning to 7 blocks: a lit creeper that near still blows within reach of the body. */
		static final double CREEPER_HANDOVER = 7.0D;

		/** A second fuse invalidates the first creeper's route, separation and any move to settle at its end. */
		private void retarget(Vec3 position) {
			start = position;
			startSeparation = Double.NaN;
			ending = null;
			settleTicks = 0;
			walk = null;
			walkNote = "";
			dropHeading = null;
			dropNote = "";
			acrossCloud = false;
			spentAcross = false;
			lastHeading = null;
			last = null;
			stuck = 0;
			repathed = false;
			glanced = 0;
			glancedAt.clear();
		}

		/** Ends the run with {@code result}, after a step back off the brink of a seen void or damaging drop when it stands on one. */
		private Step end(ServerPlayer player, Consumer<AgentInputState> input, Step result) {
			settleTo = SafeStep.brinkRetreat(player,
					cell -> dev.agaminggod.mineagen.server.perception.CloudDanger.harmAt(player, new Vec3(cell.x() + 0.5D, cell.y(), cell.z() + 0.5D)));
			if (settleTo == null) return result;
			ending = result;
			return settle(player, input);
		}

		/**
		 * A player does not stop a run on the rim: it steps back toward the middle of the footing, crouched so the step
		 * cannot carry it over, and keeps facing as it was. A few ticks at most; the run's result then stands.
		 */
		private Step settle(ServerPlayer player, Consumer<AgentInputState> input) {
			double dx = settleTo.x - player.getX(), dz = settleTo.z - player.getZ();
			if (Math.hypot(dx, dz) < 0.15D) return Step.done(ending.detail() + "; stepped back from the edge");
			if (++settleTicks > SETTLE_TICKS) return ending;
			float heading = Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz)));
			float relative = (float) Math.toRadians(AgentInputStates.shortestAngleDelta(player.getYRot(), heading));
			input.accept(new AgentInputState(Mth.clamp((float) Math.cos(relative), -1.0F, 1.0F), Mth.clamp(-(float) Math.sin(relative), -1.0F, 1.0F),
					false, true, false, false, false, player.getYRot(), player.getXRot(), player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return Step.running("stepping back from the edge");
		}

		/** Starts a run back along known walkable cells away from the threat and takes its first step; null when there is none. */
		private Step walkBack(Context context, Consumer<AgentInputState> input, double separation) {
			ServerPlayer player = context.player();
			List<GridPosition> preferred = keepClearOfPack ? context.memory().dryFooting() : List.of();
			List<GridPosition> path = SafeStep.awayPath(player, origin.x, origin.z, MAX_PATH_STEPS, MAX_PATH_CELLS, PATH_MIN_GAIN,
					cell -> runsIntoCloud(player, cell) || keepClearOfPack && packOnCell(player, cell), maxDrop, preferred);
			if (path == null) return null;
			walk = new PathWalk(path);
			GridPosition end = path.getLast();
			walkNote = String.format(Locale.ROOT, "; ran back along known ground toward %d,%d,%d (%d steps)", end.x(), end.y(), end.z(), path.size());
			Step step = walk.tick(player, input, canSprint(player));
			if (step.status() == ReflexScheduler.ActionStatus.RUNNING) return Step.running(String.format(Locale.ROOT, "%s, %.1f away", walkNote.substring(2), separation));
			walk = null;
			return null;
		}
	}

	/**
	 * Strafe toward the feet cell's centre line while the body is pressed against something: a 0.6-wide body running
	 * off-centre catches the corner of a block beside the free column it runs along (live replay of End run 62ac775e:
	 * the escape stood 1.3 s against a corner and failed as blocked); a player sidesteps it.
	 */
	static float centring(ServerPlayer player, float yaw) {
		if (!player.horizontalCollision) return 0.0F;
		double offX = Mth.floor(player.getX()) + 0.5D - player.getX(), offZ = Mth.floor(player.getZ()) + 0.5D - player.getZ();
		double radians = Math.toRadians(yaw);
		// Positive strafe moves toward (cos yaw, sin yaw): the body's left.
		double left = offX * Math.cos(radians) + offZ * Math.sin(radians);
		return Math.abs(left) < 0.1D ? 0.0F : (float) Math.signum(left);
	}

	/** Ticks an escape may spend turning to see footing it has not seen (a 180 degree turn takes about 5). */
	static final int GLANCE_TICKS = 12;
	/** Ticks of that spent on one heading. */
	static final int GLANCE_TICKS_EACH = 5;
	/** Below the horizon far enough that the cells one and two steps out, and the ground under them, are in view. */
	static final float GLANCE_PITCH = 35.0F;

	/** "walls N, NE; void E; 12-block drop S (9 damage at health 6.0); unseen ground W": every refused heading, grouped. */
	static String describe(List<SafeStep.Blocked> blocked, ServerPlayer player) {
		Map<String, List<String>> groups = new java.util.LinkedHashMap<>();
		for (SafeStep.Blocked why : blocked) {
			String kind = switch (why.barrier()) {
				case WALL -> "wall";
				case VOID -> "void";
				case HAZARD -> "lava or fire";
				case UNSEEN -> "unseen ground";
				case DROP -> String.format(Locale.ROOT, "%d-block drop (%d damage)", why.drop(), why.fallDamage());
			};
			List<String> where = groups.computeIfAbsent(kind, key -> new ArrayList<>());
			String direction = SafeStep.compass(why.yaw());
			if (!where.contains(direction)) where.add(direction);
		}
		StringBuilder text = new StringBuilder();
		for (Map.Entry<String, List<String>> group : groups.entrySet()) {
			if (!text.isEmpty()) text.append("; ");
			text.append(group.getKey()).append(' ').append(String.join(", ", group.getValue()));
		}
		return text.append(String.format(Locale.ROOT, " (health %.1f)", player.getHealth())).toString();
	}

	/** Blocks farther from the threat a path back along known ground must lead. */
	static final double PATH_MIN_GAIN = 2.0D;

	/** Whether standing in {@code cell} puts the body in a harmful cloud it is not already in. */
	static boolean runsIntoCloud(ServerPlayer player, GridPosition cell) {
		return dev.agaminggod.mineagen.server.perception.CloudDanger.newHarmAt(player, new Vec3(cell.x() + 0.5D, cell.y(), cell.z() + 0.5D));
	}

	/** Points along a sprint heading checked for a harmful cloud the body is not already in. */
	private static final double[] CLOUD_LOOKAHEAD = {1.5D, 3.0D, 4.5D};

	static boolean runsIntoCloud(ServerPlayer player, float yaw) {
		double radians = Math.toRadians(yaw);
		Vec3 direction = new Vec3(-Math.sin(radians), 0.0D, Math.cos(radians));
		for (double distance : CLOUD_LOOKAHEAD) {
			if (dev.agaminggod.mineagen.server.perception.CloudDanger.newHarmAt(player, player.position().add(direction.scale(distance)))) return true;
		}
		return false;
	}

	/** Distances along a sprint heading checked for a void edge (a column empty from the feet cell to the world's bottom). */
	private static final double[] VOID_LOOKAHEAD = {1.0D, 2.0D, 3.0D, 4.0D, 5.0D};

	static boolean runsTowardVoid(ServerPlayer player, float yaw) {
		double radians = Math.toRadians(yaw);
		double dx = -Math.sin(radians), dz = Math.cos(radians);
		int feetY = net.minecraft.util.Mth.floor(player.getY() + 1.0E-4D);
		for (double distance : VOID_LOOKAHEAD) {
			int x = net.minecraft.util.Mth.floor(player.getX() + dx * distance), z = net.minecraft.util.Mth.floor(player.getZ() + dz * distance);
			if (dev.agaminggod.mineagen.server.perception.VoidColumn.below(player.level(), x, feetY, z)) return true;
		}
		return false;
	}

	/** Steps a short reflex path may take; anything longer is a move for a program. */
	static final int MAX_PATH_STEPS = 16;
	private static final int MAX_PATH_CELLS = 1_500;

	/** Go to a cell the model named (cover it chose) by a short safe path over seen terrain. */
	static final class MoveToCell implements Behaviour {
		private final GridPosition goal;
		private final boolean sprint;
		private PathWalk walk;

		MoveToCell(GridPosition goal, boolean sprint) {
			this.goal = goal;
			this.sprint = sprint;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			String at = goal.x() + "," + goal.y() + "," + goal.z();
			// Seen lava flowing beside the cells ahead: find the way again (the search refuses the flow's cells).
			if (walk != null && walk.lavaAhead(player) != null) walk = null;
			if (walk == null) {
				if (SafeStep.feet(player).equals(goal)) return Step.done("already at " + at);
				List<GridPosition> path = SafeStep.pathTo(SafeStep.reachable(player, MAX_PATH_STEPS, MAX_PATH_CELLS), goal);
				if (path == null) return Step.failed("no short safe path to " + at + " (" + MAX_PATH_STEPS + " steps over seen footing)");
				walk = new PathWalk(path);
			}
			Step step = walk.tick(player, input, sprint);
			return step.status() == ReflexScheduler.ActionStatus.DONE ? Step.done("reached " + at) : step;
		}
	}

	static final class AwayFromEdge implements Behaviour {
		/** Steps of seen footing searched; an island's middle is often more than the move_to_cell 16 away. */
		static final int STEPS = 24;
		static final int CELLS = 2_000;
		/** Ticks spent turning to look inland before a search over seen footing is given up. */
		static final int LOOK_TICKS = 10;
		private final double blocks;
		private PathWalk walk;
		private String goalText;
		private int looked;
		private Float lookYaw;
		/** Clearance where the escape began, and whether the current walk's goal has the wanted clearance. */
		private double start = -1.0D;
		private boolean goalClear;
		private int hops;
		/** Walks toward better clearance before the escape settles for what it has. */
		static final int MAX_HOPS = 4;

		AwayFromEdge(double blocks) {
			this.blocks = blocks;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (walk != null && walk.lavaAhead(player) != null) walk = null;
			if (walk == null) {
				var escape = dev.agaminggod.mineagen.server.runtime.controller.FightingPosition.awayFromEdge(player, blocks, STEPS, CELLS,
						cell -> runsIntoCloud(player, cell));
				if (escape.here() >= blocks) return Step.done(hops == 0 ? String.format(Locale.ROOT, "already %.0f+ blocks from any seen drop", blocks)
						: "reached " + goalText);
				if (escape.path() == null && hops > 0 && looked >= LOOK_TICKS) return Step.done("reached " + goalText + "; no seen footing further from the drop");
				if (escape.path() == null) {
					// Footing behind the body may simply be unseen (it faced the drop): a player turns and looks inland first.
					if (looked < LOOK_TICKS) {
						if (lookYaw == null) {
							Float inland = dev.agaminggod.mineagen.server.runtime.controller.FightingPosition.inlandYaw(player, 3.0D);
							lookYaw = inland == null ? player.getYRot() + 180.0F : inland;
						}
						looked++;
						float yaw = AgentInputStates.turnYaw(player.getYRot(), lookYaw);
						float pitch = AgentInputStates.turnPitch(player.getXRot(), 35.0F);
						input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, false, false, yaw, pitch,
								player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
						return Step.running("looking inland for footing");
					}
					return Step.failed(String.format(Locale.ROOT,
							"no seen footing within %d steps is farther from a drop than here (%.1f blocks), after looking inland", STEPS, escape.here()));
				}
				GridPosition goal = escape.path().getLast();
				if (start < 0.0D) start = escape.here();
				goalText = String.format(Locale.ROOT, "%d,%d,%d (%s blocks from a drop, was %.1f)", goal.x(), goal.y(), goal.z(),
						escape.clearance() >= blocks ? String.format(Locale.ROOT, "%.0f+", blocks) : String.format(Locale.ROOT, "%.1f", escape.clearance()), start);
				goalClear = escape.clearance() >= blocks;
				walk = new PathWalk(escape.path());
			}
			Step step = walk.tick(player, input, canSprint(player));
			if (step.status() != ReflexScheduler.ActionStatus.DONE) return step;
			if (goalClear || ++hops >= MAX_HOPS) return Step.done("reached " + goalText);
			// Short of the clearance: the ground seen from here goes further; look inland again and keep going.
			walk = null;
			looked = 0;
			lookYaw = null;
			return Step.running("reached " + goalText + "; looking further inland");
		}
	}

	/** Hold sneak and stand still (sneaking never walks off an edge); held while the condition holds. */
	static final class Sneak implements Behaviour {
		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			input.accept(new AgentInputState(0.0F, 0.0F, false, true, false, false, false, player.getYRot(), player.getXRot(),
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return Step.running("sneaking");
		}

		@Override
		public boolean holdsWhileTrue() { return true; }
	}

	/** Look down and away from the focus (an enderman's eyes) until the view is well off it. */
	static final class LookAway implements Behaviour {
		private int clear;

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			Entity focus = context.focus() != null && context.focus().isAlive() ? context.focus() : null;
			float yaw = player.getYRot();
			float pitch = 70.0F;
			if (focus != null) {
				Vec3 delta = focus.position().subtract(player.position());
				yaw = Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-delta.x, delta.z)) + 90.0F);
				// Below the eyes: look up instead, still off to the side.
				if (focus.getEyeY() < player.getY() - 1.0D) pitch = -60.0F;
			}
			float nextYaw = AgentInputStates.turnYaw(player.getYRot(), yaw);
			float nextPitch = AgentInputStates.turnPitch(player.getXRot(), pitch);
			input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, false, false, nextYaw, nextPitch,
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			boolean watched = focus instanceof LivingEntity living && living.isLookingAtMe(player, 0.1D, true, false, living.getEyeY());
			clear = watched ? 0 : clear + 1;
			return clear >= 3 ? Step.done("looked away") : Step.running("looking away");
		}
	}

	/**
	 * Place up to {@code count} blocks from the hotbar in the cell beside the body toward the threat (feet level, then
	 * head level): quick cover. Each block goes on a face the crosshair is actually on, within reach, as a right-click.
	 */
	static final class PlaceBlock implements Behaviour {
		private final String item;
		private final int count;
		private List<BlockPos> targets;
		private final List<BlockPos> open = new ArrayList<>();
		private int slot = -1;
		private int heldSlot = -1;
		private int waited;

		PlaceBlock(String item, int count) {
			this.item = item;
			this.count = count;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			Level level = player.level();
			if (targets == null) {
				slot = blockSlot(player, item);
				if (slot < 0) return Step.failed(item == null ? "no solid block in hotbar" : "no " + item + " in hotbar");
				Vec3 threat = context.threat();
				float yaw = threat == null ? player.getYRot()
						: (float) Math.toDegrees(Math.atan2(-(threat.x - player.getX()), threat.z - player.getZ()));
				BlockPos base = player.blockPosition().relative(Direction.fromYRot(yaw));
				targets = new ArrayList<>();
				for (int index = 0; index < count; index++) targets.add(base.above(index));
				for (BlockPos cell : targets) if (level.getBlockState(cell).canBeReplaced()) open.add(cell);
				heldSlot = player.getInventory().getSelectedSlot();
			}
			BlockPos target = null;
			for (BlockPos cell : targets) {
				if (level.getBlockState(cell).canBeReplaced()) {
					target = cell;
					break;
				}
			}
			int placed = (int) open.stream().filter(cell -> !level.getBlockState(cell).canBeReplaced()).count();
			if (target == null) {
				// Back to the item held before, as a player switches back after blocking up.
				input.accept(look(player, null, 0.0F, 0.0F, false, false, heldSlot, InteractionHand.MAIN_HAND));
				return placed > 0 ? Step.done("placed " + placed + " block(s) toward the threat") : Step.done("cover already there");
			}
			if (!(player.getInventory().getItem(slot).getItem() instanceof BlockItem)) return Step.failed("ran out of blocks after " + placed);
			BlockHitResult face = face(player, target);
			if (face == null) return Step.failed("no face to place against at " + target.toShortString());
			if (++waited > 30 * targets.size()) return Step.failed("could not place at " + target.toShortString() + " (placed " + placed + ")");
			input.accept(look(player, face.getLocation(), 0.0F, 0.0F, false, clicksInto(player, face, target), slot, InteractionHand.MAIN_HAND));
			return Step.running("placing " + (placed + 1) + "/" + targets.size());
		}

		/**
		 * Whether a right click now places into {@code target}: the crosshair is on the support face it was aimed at, or on
		 * a replaceable block standing in {@code target} itself (short grass, leaf litter), which vanilla replaces with the
		 * placed block. Gate A6: the ray stopped on short grass in the first wall cell and the wall-in placed 0 of 8 blocks
		 * in 2.8 s while a skeleton shot the body from 7.2 to 3.2; gate B8 placed 0 of 9 on leaf litter.
		 */
		static boolean clicksInto(ServerPlayer player, BlockHitResult face, BlockPos target) {
			if (!(Tracer.rayTrace(player, 1.0F, player.blockInteractionRange(), false) instanceof BlockHitResult hit)
					|| hit.getType() != HitResult.Type.BLOCK) return false;
			if (hit.getBlockPos().equals(face.getBlockPos()) && hit.getDirection() == face.getDirection()) return true;
			return hit.getBlockPos().equals(target) && player.level().getBlockState(target).canBeReplaced();
		}

		/** A solid face beside {@code target} that the eye sees and can reach, as the hit a right-click there makes. */
		static BlockHitResult face(ServerPlayer player, BlockPos target) {
			Vec3 eye = player.getEyePosition();
			for (Direction toward : new Direction[] {Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST, Direction.UP}) {
				BlockPos support = target.relative(toward);
				Direction side = toward.getOpposite();
				if (!player.level().getBlockState(support).isFaceSturdy(player.level(), support, side)) continue;
				if (!player.isWithinBlockInteractionRange(support, 0.0D)) continue;
				Vec3 point = Vec3.atCenterOf(target).add(toward.getStepX() * 0.5D, toward.getStepY() * 0.5D, toward.getStepZ() * 0.5D);
				if (eye.subtract(point).dot(new Vec3(side.getStepX(), side.getStepY(), side.getStepZ())) <= 0.05D) continue;
				return new BlockHitResult(point, side, support, false);
			}
			return null;
		}

		/** A block that quick cover can use: a full, non-falling block without a block entity. */
		static boolean coverBlock(ItemStack stack) {
			if (!(stack.getItem() instanceof BlockItem block)) return false;
			return block.getBlock().defaultBlockState().isCollisionShapeFullBlock(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO)
					&& !(block.getBlock() instanceof FallingBlock) && !(block.getBlock() instanceof EntityBlock);
		}

		static int blockSlot(ServerPlayer player, String item) {
			for (int index = 0; index < 9; index++) {
				ItemStack stack = player.getInventory().getItem(index);
				if (!(stack.getItem() instanceof BlockItem block)) continue;
				if (item != null) {
					if (item.equals(id(stack))) return index;
					continue;
				}
				var state = block.getBlock().defaultBlockState();
				if (state.isCollisionShapeFullBlock(player.level(), player.blockPosition()) && !(block.getBlock() instanceof FallingBlock)
						&& !(block.getBlock() instanceof EntityBlock)) {
					return index;
				}
			}
			return -1;
		}
	}

	/**
	 * Back off to the nearest cell (by a short safe path) out of the focus mob's line of sight, at eye and body height,
	 * then report it. Plans once, from terrain the player has seen.
	 */
	/**
	 * Mine out the solid block the head is stuck in, as a player digs out of gravel or sand that fell onto it: the cells
	 * vanilla's in-wall test touches (the eye cell first), with the hotbar's fastest tool for that block, by holding attack
	 * on it (from inside a block any view targets that block). Sand or gravel that drops in after a break is mined too.
	 */
	static final class DigOut implements Behaviour {
		private static final int SETTLE_TICKS = 12;
		private BlockPos target;
		private int targetTicks;
		private int limit;
		private int broken;
		private int settle;
		private int heldSlot = -1;

		/** Suffocating cells at the eye, nearest the eye first: vanilla Entity.isInWall's box, so the HUD and this agree. */
		static List<BlockPos> stuckCells(ServerPlayer player) {
			List<BlockPos> cells = new ArrayList<>();
			if (player.noPhysics || player.isSpectator()) return cells;
			float width = player.getBbWidth() * 0.8F;
			AABB box = AABB.ofSize(player.getEyePosition(), width, 1.0E-6D, width);
			for (BlockPos pos : BlockPos.betweenClosed(box)) {
				BlockState state = player.level().getBlockState(pos);
				if (!state.isAir() && state.isSuffocating(player.level(), pos)
						&& Shapes.joinIsNotEmpty(state.getCollisionShape(player.level(), pos).move(pos), Shapes.create(box), BooleanOp.AND)) {
					cells.add(pos.immutable());
				}
			}
			BlockPos eye = BlockPos.containing(player.getEyePosition());
			cells.sort((left, right) -> Boolean.compare(!left.equals(eye), !right.equals(eye)));
			return cells;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			Level level = player.level();
			if (heldSlot < 0) heldSlot = player.getInventory().getSelectedSlot();
			if (target != null && !level.getBlockState(target).isSuffocating(level, target)) {
				broken++;
				target = null;
				settle = 0;
			}
			List<BlockPos> cells = stuckCells(player);
			if (cells.isEmpty()) {
				// Gravel above a mined cell drops a moment later: a player watches it fall before calling the shaft clear.
				if (broken > 0 && settle++ < SETTLE_TICKS && fallingAbove(player)) {
					input.accept(look(player, null, 0.0F, 0.0F, false, false, player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
					return Step.running("watching a falling block");
				}
				return broken > 0 ? Step.done("dug out " + broken + " block(s)") : Step.failed("head not inside a block");
			}
			BlockPos cell = cells.get(0);
			BlockState state = level.getBlockState(cell);
			if (!cell.equals(target)) {
				target = cell;
				targetTicks = 0;
				int slot = fastestSlot(player, state, heldSlot);
				player.getInventory().setSelectedSlot(slot);
				float progress = state.getDestroyProgress(player, level, cell);
				if (progress <= 0.0F) return Step.failed(id(state) + " at " + cell.toShortString() + " cannot be mined");
				limit = (int) Math.ceil(1.0F / progress) * 2 + 20;
			}
			if (++targetTicks > limit) return Step.failed("could not mine " + id(state) + " at " + cell.toShortString() + " (dug " + broken + ")");
			int slot = player.getInventory().getSelectedSlot();
			BlockPos eye = BlockPos.containing(player.getEyePosition());
			// The eye's own cell is hit by any view; a neighbouring cell the head overlaps is looked at.
			AgentInputState aim = cell.equals(eye) ? look(player, null, 0.0F, 0.0F, false, false, slot, InteractionHand.MAIN_HAND)
					: look(player, Vec3.atCenterOf(cell), 0.0F, 0.0F, false, false, slot, InteractionHand.MAIN_HAND);
			input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, true, false, aim.yaw(), aim.pitch(), slot, InteractionHand.MAIN_HAND));
			return Step.running("mining " + id(state) + " at " + cell.toShortString());
		}

		private static boolean fallingAbove(ServerPlayer player) {
			AABB column = player.getBoundingBox().inflate(0.5D, 0.0D, 0.5D).expandTowards(0.0D, 4.0D, 0.0D);
			return !player.level().getEntitiesOfClass(FallingBlockEntity.class, column).isEmpty();
		}

		/** The hotbar slot that mines {@code state} fastest, the held slot on a tie, as a player reaches for a shovel. */
		private static int fastestSlot(ServerPlayer player, BlockState state, int held) {
			int best = player.getInventory().getSelectedSlot();
			float speed = player.getInventory().getItem(best).getDestroySpeed(state);
			for (int index = 0; index < 9; index++) {
				float candidate = player.getInventory().getItem(index).getDestroySpeed(state);
				if (candidate > speed) {
					speed = candidate;
					best = index;
				}
			}
			return best;
		}

		@Override
		public boolean keepsSelection() { return false; }
	}

	/**
	 * Defend's cover from a ranged attacker it cannot reach, for the gap while the model thinks: walls on every open side
	 * of the body's cell, feet and head, and a roof when the shooter's eyes are above the body's head (an overhang, or the
	 * body down a drop). A cell already solid counts. Each placement is a player's click on a seen face; the body steps to
	 * the middle of its cell first and never places into itself. It does not start in or under water, with a creeper
	 * within {@link #CREEPER_RANGE} blocks, or with a mob inside or beside the cells it would enclose; while building it
	 * stops for water or a creeper, leaves a side open where a mob stands in a wall cell, and before the last block stops
	 * if a mob got inside. It ends when the walls are up and says which sides are closed; the walls stay as blocks and
	 * opening them is the model's call (its own digging and travel check lava and water). The firing ends at its maxS or
	 * the model's next command, which is never held for it.
	 */
	static final class WallIn {
		static final double CREEPER_RANGE = 6.0D;
		static final int CENTER_TICKS = 20;
		static final int STUCK_TICKS = 40;
		private final LivingEntity shooter;
		private BlockPos center;
		private final List<BlockPos> plan = new ArrayList<>();
		private final List<BlockPos> skipped = new ArrayList<>();
		private int placed;
		private int ticks;
		private boolean centred;
		private int heldSlot = -1;

		WallIn(LivingEntity shooter) {
			this.shooter = shooter;
		}

		/**
		 * Water a player cannot build from: the head under, the feet off the bottom (afloat), or a current at the feet that
		 * carries the body off the cell. Standing on the bottom of still water one deep is building ground (defend-shallow:
		 * the refusal left the bot facing a skeleton in the open at 12 health, 2 of 3 runs dead).
		 */
		static boolean unsteadyWater(ServerPlayer player) {
			if (player.isUnderWater()) return true;
			if (!player.isInWater()) return false;
			if (!player.onGround()) return true;
			var fluid = player.level().getFluidState(player.blockPosition());
			return !fluid.isEmpty() && !fluid.isSource();
		}

		/** Why the body must not wall in here now, or null. */
		static String refusal(ServerPlayer player, BlockPos center, Vec3 shooter) {
			if (unsteadyWater(player)) return "the body is in water";
			for (Creeper creeper : player.level().getEntitiesOfClass(Creeper.class, player.getBoundingBox().inflate(CREEPER_RANGE), Creeper::isAlive)) {
				if (player.distanceTo(creeper) <= CREEPER_RANGE) return "a creeper is within " + (int) CREEPER_RANGE + " blocks";
			}
			// The enclosed cells (the body's own and its eight walls, two high) and one block round them.
			AABB around = new AABB(center).expandTowards(0.0D, 1.0D, 0.0D).inflate(2.0D, 0.0D, 2.0D);
			for (Mob mob : player.level().getEntitiesOfClass(Mob.class, around, Mob::isAlive)) return type(mob) + " is inside or beside the cells to enclose";
			// Centring and placing stand the body still under fire: a shove there must not reach a lethal or unseen drop.
			String brink = brink(dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.brinkFrom(player, new Vec3(center.getX() + 0.5D, player.getY(), center.getZ() + 0.5D), shooter));
			if (brink != null) return brink + " within a shove of the cell";
			return null;
		}

		/** A brink as the refusal names it, or null. */
		static String brink(dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.Fall fall) {
			if (fall == null) return null;
			return fall.unknown() ? "an edge whose drop has no seen bottom" : switch (fall.below()) {
				case "void" -> "an edge over the void";
				case "drop" -> "an edge with a " + fall.drop() + "-block fall";
				default -> "an edge over " + fall.below();
			};
		}

		/** Releases any level hold under this wall-in's name (it takes none now; kept so an old holder can never linger). */
		void end(ServerPlayer player) {
			dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.keepLevel(player, this, false);
		}

		Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			Level level = player.level();
			if (center == null) {
				center = BlockPos.containing(player.getX(), player.getY() + 0.2D, player.getZ());
				String no = refusal(player, center, shooter.position());
				if (no != null) return Step.failed("not walling in: " + no);
				heldSlot = player.getInventory().getSelectedSlot();
				Direction facing = Direction.getApproximateNearest(shooter.getX() - player.getX(), 0.0D, shooter.getZ() - player.getZ());
				// Feet level first (each head cell stands on its feet cell), the side facing the shooter first.
				List<Direction> sides = List.of(facing, facing.getClockWise(), facing.getCounterClockWise(), facing.getOpposite());
				for (int y = 0; y < 2; y++) for (Direction side : sides) {
					BlockPos cell = center.relative(side).above(y);
					if (level.getBlockState(cell).canBeReplaced()) plan.add(cell);
				}
				BlockPos roof = center.above(2);
				if (shooter.getEyeY() > player.getY() + player.getBbHeight() && level.getBlockState(roof).canBeReplaced()) plan.add(roof);
				if (plan.isEmpty()) return Step.done(report(level, "already closed on every side"));
			}
			if (unsteadyWater(player)) return stop(level, "the body went into water");
			for (Creeper creeper : level.getEntitiesOfClass(Creeper.class, player.getBoundingBox().inflate(CREEPER_RANGE), Creeper::isAlive)) {
				if (player.distanceTo(creeper) <= CREEPER_RANGE) return stop(level, "a creeper came within " + (int) CREEPER_RANGE + " blocks");
			}
			// A shove while centring or placing is walked back (the guard's walk-back runs in an armed stance). No level
			// hold: it counts every drop off the deck, so beside a 1-block step it crouched and stood on alternate ticks.
			dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.braceArmed(player);
			if (!centred) {
				// Off centre the 0.6-wide body overlaps a wall cell; a player steps to the middle first.
				double dx = center.getX() + 0.5D - player.getX(), dz = center.getZ() + 0.5D - player.getZ();
				boolean overlaps = plan.stream().anyMatch(cell -> player.getBoundingBox().intersects(new AABB(cell)));
				if (!overlaps || Math.abs(dx) <= 0.15D && Math.abs(dz) <= 0.15D || ++ticks > CENTER_TICKS) {
					centred = true;
					ticks = 0;
				} else {
					float[] keys = dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.keysToward(player.getYRot(), dx, dz);
					input.accept(new AgentInputState(keys[0] * 0.3F, keys[1] * 0.3F, false, true, false, false, false, player.getYRot(),
							player.getXRot(), player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
					return Step.running("stepping to the middle of the cell to wall in from " + type(shooter));
				}
			}
			List<BlockPos> open = plan.stream().filter(cell -> level.getBlockState(cell).canBeReplaced() && !skipped.contains(cell)).toList();
			if (open.isEmpty()) {
				input.accept(look(player, null, 0.0F, 0.0F, false, false, heldSlot, InteractionHand.MAIN_HAND));
				return Step.done(report(level, "walled in from " + type(shooter)));
			}
			if (open.size() == 1 && insider(player) != null) return stop(level, type(insider(player)) + " got inside before the last wall");
			BlockPos target = null;
			for (BlockPos cell : open) {
				if (player.getBoundingBox().intersects(new AABB(cell))) continue;
				List<? extends LivingEntity> occupant = level.getEntitiesOfClass(LivingEntity.class, new AABB(cell), mob -> mob != player && mob.isAlive());
				if (!occupant.isEmpty()) { skipped.add(cell); continue; }
				target = cell;
				break;
			}
			if (target == null || ++ticks > STUCK_TICKS * plan.size()) return stop(level, "could not place the last wall");
			int slot = PlaceBlock.blockSlot(player, null);
			if (slot < 0) return stop(level, "ran out of blocks");
			BlockHitResult face = PlaceBlock.face(player, target);
			if (face == null) { skipped.add(target); return Step.running("no face to place against at " + target.toShortString()); }
			input.accept(look(player, face.getLocation(), 0.0F, 0.0F, false, PlaceBlock.clicksInto(player, face, target), slot, InteractionHand.MAIN_HAND));
			placed = (int) plan.stream().filter(cell -> !level.getBlockState(cell).canBeReplaced()).count();
			return Step.running("walling in from " + type(shooter) + ": " + placed + "/" + plan.size());
		}

		/** A living thing other than the body in the body's own two cells. */
		private LivingEntity insider(ServerPlayer player) {
			AABB inside = new AABB(center).expandTowards(0.0D, 1.0D, 0.0D);
			for (LivingEntity mob : player.level().getEntitiesOfClass(LivingEntity.class, inside, mob -> mob != player && mob.isAlive())) return mob;
			return null;
		}

		private Step stop(Level level, String why) {
			return Step.failed(report(level, "stopped walling in: " + why));
		}

		/** Which sides are closed (feet and head), the roof, and that opening them is the model's call. */
		private String report(Level level, String what) {
			List<String> closed = new ArrayList<>(), open = new ArrayList<>();
			for (Direction side : Direction.Plane.HORIZONTAL) {
				BlockPos feet = center.relative(side);
				boolean shut = !level.getBlockState(feet).canBeReplaced() && !level.getBlockState(feet.above()).canBeReplaced();
				(shut ? closed : open).add(side.getSerializedName());
			}
			boolean roof = !level.getBlockState(center.above(2)).canBeReplaced();
			int built = (int) plan.stream().filter(cell -> !level.getBlockState(cell).canBeReplaced()).count();
			return what + " at " + center.toShortString() + ": closed " + (closed.isEmpty() ? "none" : String.join(", ", closed))
					+ (open.isEmpty() ? "" : "; open " + String.join(", ", open)) + (roof ? "; roofed" : "; no roof")
					+ "; " + built + " block(s) placed; the walls stay up; opening a side is your call";
		}
	}

	static final class TakeCover implements Behaviour {
		/** Turns of the view (120 degrees apart) a cover search looks around before it decides there is none. */
		private static final int GLANCE_TURNS = 3;
		private static final int TICKS_PER_TURN = 4;
		private final int within;
		private PathWalk walk;
		private GridPosition cover;
		private int glanced;
		private float glanceStart = Float.NaN;
		private PlaceBlock wall;
		private LivingEntity shooter;
		private final Shield walkingGuard;
		/** With no hiding cell in reach, build two blocks of cover from the hotbar; false: natural cover only. */
		private final boolean buildsCover;
		private String why;
		/**
		 * A rule's firing: with no cell that hides and no block to build cover, it ends done and says so instead of failing,
		 * since four failures in a row would switch the rule off (blaze cover with it) for nothing it could have done.
		 * Defend's own cover step keeps the failure, which paces its retries.
		 */
		private final boolean openGroundDone;
		/** Where the last shot due within {@link #SHIELD_SHOT_SECONDS} came from, and when it was seen. */
		private Vec3 shotFrom;
		private long shotTick;
		private int shieldTicks;
		/**
		 * A shield in hand: this firing answers shots itself (see {@link #blocksShots}), in every phase and still once
		 * {@link #MAX_SHIELD_TICKS} ends its stops, since a shield rule taking the body then would end cover for good.
		 */
		private boolean blocking;
		/** Ticks the shield stays up after the last shot was seen coming: the 5-tick raise, so a shot just past is not missed. */
		static final long BLOCK_AFTER_SHOT_TICKS = 5L;
		/**
		 * Shield-up ticks a firing spends at most: steady fire from several shooters would otherwise hold the body in the
		 * open until the firing times out; past them it goes on without stopping.
		 */
		static final int MAX_SHIELD_TICKS = 40;

		TakeCover(int within, boolean openGroundDone) {
			this(within, openGroundDone, false);
		}

		TakeCover(int within, boolean openGroundDone, boolean guardWhileWalking) {
			this(within, openGroundDone, guardWhileWalking, true);
		}

		TakeCover(int within, boolean openGroundDone, boolean guardWhileWalking, boolean buildsCover) {
			this.buildsCover = buildsCover;
			this.within = within;
			this.openGroundDone = openGroundDone;
			this.walkingGuard = guardWhileWalking ? new Shield() : null;
		}

		boolean endsDoneInOpenGround() {
			return openGroundDone;
		}

		@Override
		public boolean blocksShots() {
			return blocking;
		}

		/**
		 * Whether this tick stops to block: a shield in hand, a shot seen coming within the last few ticks and fewer than
		 * {@link #MAX_SHIELD_TICKS} ticks of shield already spent this firing.
		 */
		static boolean blocksNow(boolean shieldInHand, long ticksSinceShot, int shieldTicks) {
			return shieldInHand && ticksSinceShot >= 0L && ticksSinceShot <= BLOCK_AFTER_SHOT_TICKS && shieldTicks < MAX_SHIELD_TICKS;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			Step blocked = blockShot(player, input);
			if (blocked != null) return blocked;
			if (wall != null) return buildCover(context, input);
			if (walk == null) {
				// The condition's mob; when it names none (low health), the hostiles that see the player and can shoot it,
				// since cover stops shots and a melee mob walks around it; with no shooter, every hostile that sees it.
				List<? extends LivingEntity> from;
				if (context.focus() instanceof LivingEntity mob && mob.isAlive()) from = List.of(mob);
				else {
					List<Mob> seen = watchers(player);
					List<Mob> shooters = seen.stream().filter(ThreatPerception::isRanged).toList();
					from = shooters.isEmpty() ? seen : shooters;
				}
				if (from.isEmpty()) return Step.failed("no mob to take cover from");
				String who = from.size() == 1 ? type(from.getFirst()) : from.size() + " mobs";
				Map<GridPosition, GridPosition> reach = SafeStep.reachable(player, within, MAX_PATH_CELLS);
				for (GridPosition cell : reach.keySet()) {
					if (!from.stream().allMatch(mob -> hidden(player, mob, mob.getEyePosition(), cell))) continue;
					if (reach.get(cell) == null) return Step.done("already out of sight of " + who);
					cover = cell;
					shooter = from.getFirst();
					walk = new PathWalk(SafeStep.pathTo(reach, cell));
					break;
				}
				if (walk == null) {
					// Ground the eye has not seen limits the search: a player looks around once before deciding.
					if (glanced < GLANCE_TURNS * TICKS_PER_TURN && SafeStep.unseenBeside(player, reach.keySet())) {
						if (Float.isNaN(glanceStart)) glanceStart = player.getYRot();
						float yaw = glanceStart + 120.0F * (1 + glanced / TICKS_PER_TURN);
						glanced++;
						input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, false, false,
								AgentInputStates.turnYaw(player.getYRot(), Mth.wrapDegrees(yaw)), AgentInputStates.turnPitch(player.getXRot(), GLANCE_PITCH),
								player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
						return Step.running("looking around for cover");
					}
					why = "no cell within " + within + " steps hides from " + who + " (" + reach.size() + " cells reachable over seen ground)";
					// In the open a player with blocks makes the cover: two blocks between it and the nearest shooter.
					shooter = from.getFirst();
					if (!buildsCover || PlaceBlock.blockSlot(player, null) < 0) {
						String open = why + (buildsCover ? "; no solid block in the hotbar to build cover" : "; not building cover here");
						return openGroundDone ? Step.done(open + "; stayed in the open") : Step.failed(open);
					}
					wall = new PlaceBlock(null, 2);
					return buildCover(context, input);
				}
			}
			GridPosition flow = walk.lavaAhead(player);
			if (flow != null) {
				walk = null;
				return Step.running("lava flows beside the way to cover at " + flow.x() + "," + flow.y() + "," + flow.z() + "; choosing cover again");
			}
			boolean walkingShielded = walkingGuard != null && shieldHand(player) != null && shooter instanceof Mob mob
					&& ThreatPerception.isRanged(mob) && mob.hasLineOfSight(player);
			// A raised shield slows a step, so that walk uses a smaller threshold for physical progress.
			Step step = walkingShielded ? walk.tick(player, state -> walkingGuard.tick(
					new Context(player, shooter, context.stance(), context.memory(), null, state, false), input), false, true, 0.0001D)
					: walk.tick(player, input, true);
			return switch (step.status()) {
				case DONE -> Step.done("in cover at " + cover.x() + "," + cover.y() + "," + cover.z() + shielded());
				case RUNNING -> Step.running(step.detail() + shielded());
				case FAILED -> Step.failed(step.detail() + shielded());
			};
		}

		/**
		 * A player taking cover under fire stops and turns the shield to a shot about to land, then goes on: walking behind
		 * a raised shield moves at a fifth of the speed, and the walk, the look around and the wall each aim the view the
		 * shield turns away. The blocking step, or null when this tick goes on with cover.
		 */
		private Step blockShot(ServerPlayer player, Consumer<AgentInputState> input) {
			InteractionHand hand = shieldHand(player);
			blocking = hand != null;
			if (hand == null) return null;
			long now = player.level().getGameTime();
			Entity shot = ReflexSensors.incomingShot(player, SHIELD_SHOT_SECONDS);
			if (shot != null) {
				shotFrom = ReflexSensors.aimPoint(shot);
				shotTick = now;
			}
			if (shotFrom == null || !blocksNow(true, now - shotTick, shieldTicks)) return null;
			shieldTicks++;
			input.accept(look(player, shot == null ? shotFrom : ReflexSensors.strikeFacing(player, shot), 0.0F, 0.0F, false, true,
					player.getInventory().getSelectedSlot(), hand));
			String phase = wall != null ? "while building cover toward " + type(shooter)
					: walk != null ? "on the way to cover at " + cover.x() + "," + cover.y() + "," + cover.z() : "while looking for cover";
			return Step.running("blocking a shot " + phase + shielded());
		}

		private String shielded() {
			if (shieldTicks == 0) return "";
			return String.format(Locale.ROOT, "; shield up %.1f s", shieldTicks / 20.0D)
					+ (shieldTicks >= MAX_SHIELD_TICKS ? ", the most one firing blocks" : "");
		}

		/** The hand holding a shield, the offhand first, or null. */
		private static InteractionHand shieldHand(ServerPlayer player) {
			return player.getOffhandItem().is(Items.SHIELD) ? InteractionHand.OFF_HAND
					: player.getMainHandItem().is(Items.SHIELD) ? InteractionHand.MAIN_HAND : null;
		}

		private Step buildCover(Context context, Consumer<AgentInputState> input) {
			Context toward = new Context(context.player(), shooter, context.stance(), context.memory(), shooter.position(), context.below(), context.fightShields());
			Step step = wall.tick(toward, input);
			String detail = why + "; " + step.detail() + " toward " + type(shooter) + shielded();
			return switch (step.status()) {
				case RUNNING -> Step.running(step.detail());
				case DONE -> Step.done(detail);
				case FAILED -> Step.failed(detail);
			};
		}

		private static boolean hidden(ServerPlayer player, LivingEntity mob, Vec3 eye, GridPosition cell) {
			for (double height : new double[] {0.9D, 1.62D}) {
				Vec3 point = new Vec3(cell.x() + 0.5D, cell.y() + height, cell.z() + 0.5D);
				if (player.level().clip(new ClipContext(eye, point, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, mob)).getType()
						== HitResult.Type.MISS) return false;
			}
			return true;
		}
	}

	/**
	 * Walk to the nearest cell the whole body can stand in without touching fire or lava, over seen footing at most
	 * {@link #LEAVE_FIRE_STEPS} steps away: a player stepping out of the flames a blaze's fireball left at their feet, or
	 * backing out of lava that flowed into a tunnel. Inside lava a player holds jump and forward (lava slows walking and
	 * jump swims up and over a ledge); with no dry cell in reach it swims to the nearest seen exit (the exits facts name).
	 * For lava the exit is out of the seen flow's way ({@link LavaSpread}): a cell the spread reaches within its horizon
	 * is where the lava goes next, so a pit below a flow or a tunnel cell ahead of it is no way out (d22-lava2: the body
	 * jumped out of a flow into the pit under it). It also runs before contact, while the flow is on its way to the body
	 * (armed on lava_flowing), and ends only standing (or swimming) out of the flow's way, not in the air over a drop.
	 */
	static final class LeaveFire implements Behaviour {
		static final int LEAVE_FIRE_STEPS = 6;
		/** With no exit out of the seen flow's way within {@link #LEAVE_FIRE_STEPS}, the search goes this far. */
		static final int LEAVE_FIRE_FAR_STEPS = MAX_PATH_STEPS;
		static final int LAVA_CLEARANCE = 3;
		/** Ticks between checks that the chosen exit is still out of the flow's way. */
		static final int EXIT_RECHECK_TICKS = 5;
		/** A flow reaching the body this soon is lava to leave even before it touches. */
		static final double FLOW_LEAVE_SECONDS = 4.0D;
		private PathWalk walk;
		private GridPosition exit;
		/** The exit was chosen out of the seen flow's way (not the cell it reaches last). */
		private boolean exitOut;
		/** The water-bucket douse of a burn held out of the flames, tried once per firing. */
		private Place douse;
		private boolean doused;
		static final String WATER_BUCKET = "minecraft:water_bucket";

		/** A water bucket in the hotbar or offhand, and water that stays where it is placed (not the Nether). */
		static boolean canDouse(ServerPlayer player) {
			if (player.level().environmentAttributes().getValue(net.minecraft.world.attribute.EnvironmentAttributes.WATER_EVAPORATES, player.blockPosition())) return false;
			if (player.getOffhandItem().is(net.minecraft.world.item.Items.WATER_BUCKET)) return true;
			for (int index = 0; index < 9; index++) if (player.getInventory().getItem(index).is(net.minecraft.world.item.Items.WATER_BUCKET)) return true;
			return false;
		}
		private String hazard;
		private int sinceChoice;
		/** Out of the hazard on safe footing with the body still burning: what the result says until the burn ends. */
		private String afterburn;
		/** Ticks spent putting out fire the body stands in with no fire-free cell to step to. */
		private int punchTicks;
		private boolean punching;
		static final int PUNCH_TICKS = 60;

		/**
		 * Out and still burning, the rule keeps running on the footing it reached until the fire goes out (decision 13), so
		 * its result is the burn's end; a higher rule or a model command still takes the body. Its maxS ends it as done.
		 */
		@Override
		public boolean settled() {
			return afterburn != null;
		}

		/**
		 * Out of a fire block and only burning: standing still does not put a burn out, and a paused fight against blazes
		 * left them free hits (d41 platform fixture: 8 s held by default-fire, no swing and no shield, while blazes hit).
		 * The fight steps off fire itself. Lava's afterburn still holds (decision 13).
		 */
		@Override
		public boolean yieldsToFight() {
			return afterburn != null && HazardExits.Contact.FIRE.wire.equals(hazard);
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (punching) {
				BlockPos fire = HazardExits.fireTouched(player);
				if (fire != null && punchTicks < PUNCH_TICKS) return punchOut(player, fire, input);
				if (fire != null) return Step.failed("could not put out the fire at " + fire.toShortString() + " in " + PUNCH_TICKS / 20 + " s");
				punching = false;
				walk = null;
			}
			if (afterburn != null) {
				if (safeFooting(player)) {
					// Water extinguishes before Place finishes aiming and scooping its source back.
					if (douse == null && !player.isOnFire()) return Step.done(afterburn + "; no longer burning");
					return holdBurning(afterburn, context, player, input);
				}
				// Shoved or slid off it, or the flow came on: get out again.
				afterburn = null;
				walk = null;
			}
			if (walk != null && hazard.equals(HazardExits.Contact.LAVA.wire) && ++sinceChoice >= EXIT_RECHECK_TICKS) {
				sinceChoice = 0;
				// Lava keeps spreading while the body walks out: an exit it has reached, now sits under or will reach
				// soon is no way out (d22-lava: the flow ran down into the pit chosen as the exit and the body burned there).
				if (!fireFree(player, exit) || lavaAbove(player, exit) || exitOut && flowReaches(LavaSpread.reach(player), exit)) walk = null;
			}
			if (walk == null) {
				sinceChoice = 0;
				HazardExits.Contact contact = HazardExits.contact(player);
				// When the flow arrives: as vanilla spreads it now. Where it may go: every open side (LavaSpread.reach).
				LavaSpread.Arrival coming = LavaSpread.of(player).box(player.getBoundingBox());
				LavaSpread.Prediction flow = LavaSpread.reach(player);
				boolean flowing = coming != null && coming.seconds() <= FLOW_LEAVE_SECONDS;
				if (contact == null && !flowing) {
					// Out of the hazard but still in the air (jumped out over a drop): landing is part of getting out.
					if (!player.onGround() && !player.isInWater() && hazard != null) return Step.running("landing out of " + hazard);
					if (hazard != null && player.isOnFire() && safeFooting(player)) return holdBurning("out of " + hazard, context, player, input);
					return Step.done("not touching fire or lava" + burnRemaining(player));
				}
				hazard = contact != null ? contact.wire : HazardExits.Contact.LAVA.wire;
				GridPosition feet = SafeStep.feet(player);
				Map<GridPosition, GridPosition> reach = SafeStep.reachable(player, LEAVE_FIRE_STEPS, MAX_PATH_CELLS);
				choose(player, reach, contact, flow, feet);
				if (exit == null || !exitOut && contact != HazardExits.Contact.FIRE && contact != HazardExits.Contact.HOT_FLOOR) {
					// Nothing out of the flow's way that near: look further over seen footing, with the same flow checks,
					// before settling for a cell the flow reaches last or swimming for a landing.
					Map<GridPosition, GridPosition> far = SafeStep.reachable(player, LEAVE_FIRE_FAR_STEPS, MAX_PATH_CELLS);
					GridPosition nearExit = exit;
					choose(player, far, contact, flow, feet);
					if (exitOut || nearExit == null) reach = far;
					else exit = nearExit;
				}
				// Back out along supported ground we just walked, if the seen flow will not reach it.
				if (contact == HazardExits.Contact.LAVA) {
					for (GridPosition previous : context.memory().dryFooting()) {
						if (previous.equals(feet) || !reach.containsKey(previous) || !fireFree(player, previous)
								|| lavaBelow(player, previous) || lavaAbove(player, previous) || flowReaches(flow, previous)) continue;
						exit = previous;
						exitOut = true;
						break;
					}
				}
				walk = null;
				if (exit != null) {
					List<GridPosition> path = SafeStep.pathTo(reach, exit);
					walk = new PathWalk(path.isEmpty() ? List.of(exit) : path, 0.1D);
				}
				if (walk == null && contact == HazardExits.Contact.LAVA) {
					// A pool: no dry step from the feet, so swim straight for the cheapest seen landing.
					for (HazardExits.Exit landing : HazardExits.scan(player)) {
						exit = new GridPosition(landing.x(), landing.y(), landing.z());
						walk = new PathWalk(List.of(exit), 0.1D);
						break;
					}
				}
				if (walk == null && contact == HazardExits.Contact.FIRE) {
					// No fire-free cell to step to (a one-cell shelter lit through its window: d41 live floor deaths stood
					// in it 15 s): punch the flame out, as a player does.
					BlockPos fire = HazardExits.fireTouched(player);
					if (fire != null) { punching = true; return punchOut(player, fire, input); }
				}
				if (walk == null) return Step.failed("no seen " + hazard + "-free footing within " + LEAVE_FIRE_FAR_STEPS + " steps"
						+ (contact == null && coming != null ? " (" + coming.describe() + ")" : ""));
			}
			if (player.isInLava()) {
				GridPosition next = walk.next(player);
				if (next != null) {
					input.accept(swimToward(player, next));
					return Step.running("swimming out of lava toward " + exit.x() + "," + exit.y() + "," + exit.z());
				}
			}
			Step step = walk.tick(player, input, false);
			if (step.status() == ReflexScheduler.ActionStatus.FAILED && HazardExits.Contact.FIRE.wire.equals(hazard)) {
				// The way out is blocked (a shelter wall the seen terrain did not hold): punch the flame out instead.
				BlockPos fire = HazardExits.fireTouched(player);
				if (fire != null) { punching = true; walk = null; return punchOut(player, fire, input); }
			}
			if (step.status() == ReflexScheduler.ActionStatus.DONE && player.isInLava()) {
				// The path's last cell is reached but lava still holds the body (it flowed there): keep swimming at it.
				input.accept(swimToward(player, exit));
				return Step.running("swimming out of lava toward " + exit.x() + "," + exit.y() + "," + exit.z());
			}
			if (step.status() != ReflexScheduler.ActionStatus.DONE) return step;
			// Reaching a cell's approach radius does not mean the whole body left its neighbouring flame.
			if (HazardExits.inHazardBlock(player) || !player.onGround() && !player.isInWater()
					|| hazard.equals(HazardExits.Contact.LAVA.wire) && flowReaches(LavaSpread.reach(player), exit)) {
				walk = null;
				return Step.running("not clear of " + hazard + " yet; checking footing");
			}
			String out = "out of " + hazard + " at " + exit.x() + "," + exit.y() + "," + exit.z();
			if (player.isOnFire() && safeFooting(player)) return holdBurning(out, context, player, input);
			return Step.done(out + burnRemaining(player));
		}

		/** Turn the view onto the fire's outline at the feet and click it once the view ray ends on it. */
		private Step punchOut(ServerPlayer player, BlockPos fire, Consumer<AgentInputState> input) {
			int slot = player.getInventory().getSelectedSlot();
			AgentInputState aim = look(player, HazardExits.fireAim(fire), 0.0F, 0.0F, false, false, slot, InteractionHand.MAIN_HAND);
			punchTicks++;
			boolean onIt = HazardExits.viewHits(player, fire);
			input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, onIt && !player.isUsingItem(), false, aim.yaw(), aim.pitch(), slot, InteractionHand.MAIN_HAND));
			return Step.running("no fire-free footing in reach; putting out the fire at " + fire.toShortString());
		}

		/** Out on safe footing and still burning: stand there, running, until the fire is out (see {@link #settled}). */
		private Step holdBurning(String out, Context context, ServerPlayer player, Consumer<AgentInputState> input) {
			afterburn = out;
			// A player out of the flames with a water bucket douses the burn instead of standing in it: water at the feet
			// puts the fire out at once and the source is scooped back (Place's clutch finish). Not where water evaporates.
			if (douse == null && !doused && canDouse(player)) {
				douse = new Place(WATER_BUCKET, "below");
				doused = true;
			}
			if (douse != null) {
				Step step = douse.tick(context, input);
				if (step.status() == ReflexScheduler.ActionStatus.RUNNING) return Step.running(out + "; dousing the burn with water: " + step.detail());
				douse = null;
				if (!player.isOnFire()) return Step.done(out + "; doused with water: " + step.detail());
			}
			input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, false, false,
					player.getYRot(), player.getXRot(), player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return Step.running(out + burnRemaining(player) + "; holding this footing until the fire is out");
		}

		/**
		 * The exit among {@code reach}'s cells (breadth first, so the first fire-free cell is the nearest by steps: the
		 * feet cell when only the body's edge burns) into {@link #exit}, and whether it is out of the seen flow's way.
		 */
		private void choose(ServerPlayer player, Map<GridPosition, GridPosition> reach, HazardExits.Contact contact,
				LavaSpread.Prediction flow, GridPosition feet) {
			GridPosition clear = null, apart = null, edge = null, outClear = null, outApart = null, outEdge = null, latest = null;
			double latestSeconds = -1.0D;
			for (GridPosition cell : reach.keySet()) {
				if (!fireFree(player, cell)) continue;
				if (contact == HazardExits.Contact.FIRE || contact == HazardExits.Contact.HOT_FLOOR) {
					clear = cell;
					break;
				}
				// Out of lava means standing beside it, not floating in the cell over it (a hole broken into a pool).
				if (cell.equals(feet) || lavaBelow(player, cell)) continue;
				// Lava above the cell within a step flows down into it: a pit below a flow is where the flow goes next.
				if (lavaAbove(player, cell)) continue;
				LavaSpread.Arrival arrives = flow.standing(cell.x(), cell.y(), cell.z());
				boolean out = arrives == null;
				if (!out && arrives.seconds() > latestSeconds) {
					latest = cell;
					latestSeconds = arrives.seconds();
				}
				boolean beside = lavaWithin(player, cell, 1), near = lavaWithin(player, cell, LAVA_CLEARANCE);
				if (out) {
					if (outEdge == null) outEdge = cell;
					if (outApart == null && !beside) outApart = cell;
					if (!near) {
						outClear = cell;
						break;
					}
				}
				if (edge == null) edge = cell;
				if (apart == null && !beside) apart = cell;
				if (clear == null && !near) clear = cell;
			}
			exitOut = outClear != null || outApart != null || outEdge != null;
			exit = outClear != null ? outClear : outApart != null ? outApart : outEdge != null ? outEdge
					: latest != null ? latest : clear != null ? clear : apart != null ? apart : edge;
		}

		/** Standing (or swimming) out of fire and lava, off a hot floor, where the seen flow does not reach. */
		private boolean safeFooting(ServerPlayer player) {
			if (HazardExits.contact(player) != null || HazardExits.inHazardBlock(player)) return false;
			if (!player.onGround() && !player.isInWater()) return false;
			LavaSpread.Arrival coming = LavaSpread.of(player).box(player.getBoundingBox());
			return coming == null || coming.seconds() > FLOW_LEAVE_SECONDS;
		}

		/** The seen flow reaches the cell's feet or head within the prediction's horizon. */
		static boolean flowReaches(LavaSpread.Prediction flow, GridPosition cell) {
			return flow.standing(cell.x(), cell.y(), cell.z()) != null;
		}

		/** Forward (and jump unless the cell is lower) toward the cell, as a player in lava does: jump swims up and over a ledge. */
		private static AgentInputState swimToward(ServerPlayer player, GridPosition cell) {
			Vec3 centre = new Vec3(cell.x() + 0.5D, player.getEyeY(), cell.z() + 0.5D);
			AgentInputState aim = look(player, centre, 0.0F, 0.0F, false, false, player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND);
			float error = AgentInputStates.shortestAngleDelta(aim.yaw(), (float) Math.toDegrees(Math.atan2(-(centre.x - player.getX()), centre.z - player.getZ())));
			// Swim horizontally toward shore even when its remembered landing is high above us. Rising in place
			// beneath a 40-block cliff never closes the distance to its wall or a climbable rim.
			float forward = CombatPlanning.alignedForward(1.0F, error);
			// Jump swims up: for a way out level with or above the feet, or a ledge in the way. Toward a lower one it
			// only lifts the body up into the lava pouring onto it (d22-lava2 replay: it rose into a lava fall).
			boolean jump = cell.y() >= Mth.floor(player.getY()) || player.horizontalCollision;
			return new AgentInputState(forward, 0.0F, jump, false, false, false, false,
					aim.yaw(), aim.pitch(), aim.selectedSlot(), aim.hand());
		}

		private static String burnRemaining(ServerPlayer player) {
			return player.isOnFire() ? "; still burning " + (player.getRemainingFireTicks() + 19) / 20
					+ " s (raw 1 HP/s); dry ground does not extinguish" : "; no longer burning";
		}

		static boolean touchesFire(ServerPlayer player) {
			return HazardExits.contact(player) == HazardExits.Contact.FIRE;
		}

		/** Lava within {@code radius} horizontal cells of the feet or head cell, or up to two above the head. */
		private static boolean lavaWithin(ServerPlayer player, GridPosition cell, int radius) {
			BlockPos.MutableBlockPos at = new BlockPos.MutableBlockPos();
			for (int dx = -radius; dx <= radius; dx++) {
				for (int dz = -radius; dz <= radius; dz++) {
					for (int dy = 0; dy <= 3; dy++) {
						if (dy >= 2 && (dx != 0 || dz != 0)) continue;
						if (player.level().getFluidState(at.set(cell.x() + dx, cell.y() + dy, cell.z() + dz)).is(net.minecraft.tags.FluidTags.LAVA)) return true;
					}
				}
			}
			return false;
		}

		/** Lava higher than the feet within one cell (beside or over the head, up to three above), so it can flow down here. */
		static boolean lavaAbove(ServerPlayer player, GridPosition cell) {
			BlockPos.MutableBlockPos at = new BlockPos.MutableBlockPos();
			for (int dx = -1; dx <= 1; dx++) {
				for (int dz = -1; dz <= 1; dz++) {
					for (int dy = dx == 0 && dz == 0 ? 2 : 1; dy <= 3; dy++) {
						if (player.level().getFluidState(at.set(cell.x() + dx, cell.y() + dy, cell.z() + dz)).is(net.minecraft.tags.FluidTags.LAVA)) return true;
					}
				}
			}
			return false;
		}

		private static boolean lavaBelow(ServerPlayer player, GridPosition cell) {
			return player.level().getFluidState(new BlockPos(cell.x(), cell.y() - 1, cell.z())).is(net.minecraft.tags.FluidTags.LAVA);
		}

		/** Feet and head cells hold no fire or lava (a body centred in the cell overlaps only those two). */
		static boolean fireFree(ServerPlayer player, GridPosition cell) {
			BlockState floor = player.level().getBlockState(new BlockPos(cell.x(), cell.y() - 1, cell.z()));
			if (HazardExits.hotFloor(floor)) return false;
			for (int dy = 0; dy <= 1; dy++) {
				BlockState state = player.level().getBlockState(new BlockPos(cell.x(), cell.y() + dy, cell.z()));
				if (state.is(net.minecraft.tags.BlockTags.FIRE) || HazardExits.hotFloor(state)
						|| state.getFluidState().is(net.minecraft.tags.FluidTags.LAVA)) return false;
			}
			return true;
		}
	}

	private static String id(ItemStack stack) {
		return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
	}

	private static String id(BlockState state) {
		return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
	}

	private static String type(Entity entity) {
		return BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
	}
}
