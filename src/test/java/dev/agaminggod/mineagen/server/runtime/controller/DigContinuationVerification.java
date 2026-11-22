package dev.agaminggod.mineagen.server.runtime.controller;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.agaminggod.mineagen.protocol.ActionType;
import dev.agaminggod.mineagen.protocol.ProtocolCodec;
import java.lang.reflect.Field;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;

/** Option contracts and bounded perceived cave geometry. Physics and Q-drop run in test-dig-options-live. */
public final class DigContinuationVerification {
	public static int verify() {
		int n = 0;
		try {
			for (ActionType type : List.of(ActionType.DIG_TO, ActionType.TRAVEL_TO)) {
				String goal = type == ActionType.DIG_TO ? "\"y\":-55," : "\"x\":5,\"z\":0,";
				for (String mode : List.of("false", "true", "\"small\"")) {
					JsonObject args = JsonParser.parseString("{" + goal + "\"throughCaves\":" + mode + ",\"sealFluids\":true,\"discard\":[\"minecraft:cobblestone\"],\"timeoutMs\":30000}").getAsJsonObject();
					ProtocolCodec.validateActionArguments(type, args); n++;
				}
				for (String bad : List.of("\"throughCaves\":\"large\"", "\"discard\":true", "\"discard\":[7]", "\"sealFluids\":1")) {
					boolean rejected = false;
					try { ProtocolCodec.validateActionArguments(type, JsonParser.parseString("{" + goal + bad + ",\"timeoutMs\":30000}").getAsJsonObject()); }
					catch (dev.agaminggod.mineagen.protocol.ProtocolException expected) { rejected = true; }
					check(rejected, "invalid option rejected by Java entry point: " + bad); n++;
				}
			}
			ServerDigController dig = new ServerDigController(ServerDigController.Pattern.STAIRS_DOWN, -55, null, null, null, 100, 30000, 0, null);
			dig.continuationOptions("small", false, List.of());
			check(value(dig,"smallCaves").equals(true) && value(dig,"throughCaves").equals(true), "small mode allows bounded caves"); n++;
			check(value(dig,"sealFluids").equals(false) && ((Set<?>)value(dig,"discard")).isEmpty(), "default fluid and discard choices are off"); n++;
			dig.continuationOptions("false", true, List.of("tuff"));
			check(value(dig,"throughCaves").equals(false) && value(dig,"sealFluids").equals(true) && ((Set<?>)value(dig,"discard")).equals(Set.of("minecraft:tuff")), "independent choices survive normalization"); n++;
			dig.continuationOptions("true", false, List.of());
			check(value(dig,"throughCaves").equals(true) && value(dig,"smallCaves").equals(false), "explicit true preserves broad cave mode"); n++;
			check(ServerDigController.sealFluidsOption(JsonParser.parseString("{\"y\":-55}").getAsJsonObject()), "sealFluids defaults on when the call leaves it out"); n++;
			check(!ServerDigController.sealFluidsOption(JsonParser.parseString("{\"y\":-55,\"sealFluids\":false}").getAsJsonObject()), "explicit sealFluids:false opts out"); n++;
			net.minecraft.world.level.block.state.BlockState stone = net.minecraft.world.level.block.Blocks.STONE.defaultBlockState();
			// Tool tags are not bound here, so vanilla's numbers stand in: a wooden pickaxe mines stone in ceil(1.5*30/2) = 23
			// ticks; by hand it takes 150 (stone) or 40 (netherrack, checked in TravelVerification).
			check(TravelBuilder.maximumTunnelMineTicks(stone) >= 23, "travel_to tunnels stone with a wooden pickaxe (23 ticks)"); n++;
			check(TravelBuilder.mineTicks(net.minecraft.world.item.ItemStack.EMPTY, stone, 1.5F) > TravelBuilder.maximumTunnelMineTicks(stone),
					"travel_to does not tunnel stone by hand"); n++;
			check(ServerTravelController.digsUp(60.0D, 64.0D, 3.0D) && !ServerTravelController.digsUp(60.0D, 63.0D, 3.0D) && !ServerTravelController.digsUp(60.0D, Double.NaN, 3.0D),
					"travel_to digs stairs up only past the arrival band"); n++;
			JsonObject trip = JsonParser.parseString("{\"x\":12,\"y\":30,\"z\":0,\"sealFluids\":false,\"throughCaves\":false,\"discard\":[\"minecraft:dirt\"]}").getAsJsonObject();
			JsonObject stairs = ServerTravelController.staircase(trip, 30, 12, 0, 60_000L, 40);
			check("stairs_down".equals(stairs.get("pattern").getAsString()) && !ServerDigController.sealFluidsOption(stairs)
					&& !stairs.get("throughCaves").getAsBoolean() && stairs.getAsJsonArray("discard").size() == 1, "travel staircase keeps sealFluids:false, throughCaves and discard"); n++;
			check("stairs_up".equals(ServerTravelController.staircase(new JsonObject(), 50, 12, 0, 60_000L, 40).get("pattern").getAsString())
					&& ServerDigController.sealFluidsOption(ServerTravelController.staircase(new JsonObject(), 50, 12, 0, 60_000L, 40)), "travel staircase goes up to a higher target and seals by default"); n++;
			check(ServerDigController.outInTheOpen(false, true, true, () -> true), "stairs_up out of the ground: a step with nothing to dig into dry open air under sky ends the climb"); n++;
			check(!ServerDigController.outInTheOpen(false, true, true, () -> false), "stairs_up under a ledge or cave mouth (roof over the step) climbs on"); n++;
			check(!ServerDigController.outInTheOpen(false, true, false, () -> true), "stairs_up with rock still to cut in the step (a ledge edge) digs on"); n++;
			check(!ServerDigController.outInTheOpen(true, true, true, () -> true), "stairs_up with ground under the next step (a hillside) digs on"); n++;
			check(!ServerDigController.outInTheOpen(false, false, true, () -> true), "stairs_up over water under sky still places its step"); n++;
			BlockPos stepAt = new BlockPos(0, 70, 0);
			check(!ServerDigController.groundRisesAhead(stepAt, net.minecraft.core.Direction.EAST, column -> 69), "flat ground ahead (top at the step's floor): nothing rises"); n++;
			check(ServerDigController.groundRisesAhead(stepAt, net.minecraft.core.Direction.EAST, column -> column.getX() == 4 ? 77 : 63), "a pit wall 4 steps ahead rises into the stairs"); n++;
			check(!ServerDigController.groundRisesAhead(stepAt, net.minecraft.core.Direction.EAST, column -> column.getX() == 5 ? 77 : 63), "a wall 5 steps ahead is past the look"); n++;
			check(!ServerDigController.groundRisesAhead(stepAt, net.minecraft.core.Direction.EAST, column -> column.getX() == 3 ? 72 : 69), "a gentle rise that stays under the stairs does not"); n++;
			BlockPos origin = new BlockPos(0,64,0);
			Set<BlockPos> air = new HashSet<>();
			for(int x=0;x<2;x++) for(int y=64;y<66;y++) for(int z=0;z<2;z++) air.add(new BlockPos(x,y,z));
			check(ServerDigController.smallOpening(origin,air::contains), "eight seen cells fit small mode"); n++;
			for(int x=0;x<4;x++) for(int y=64;y<68;y++) for(int z=0;z<4;z++) air.add(new BlockPos(x,y,z));
			check(!ServerDigController.smallOpening(origin,air::contains), "large seen chamber exceeds 24 cells"); n++;
			air.clear();for(int x=0;x<5;x++) air.add(origin.offset(x,0,0));
			check(!ServerDigController.smallOpening(origin,air::contains), "long opening exceeds three-block bounds"); n++;
			String message = ServerRetraceController.timeoutText("deadline",40,40,1,64,2,86,7,"{x:8,y:64,z:2,retrace:true}");
			check(message.contains("40/40") && message.contains("7.0 route blocks remaining including final approach") && !message.contains("To resume"), "finished waypoints still report final distance and resume"); n++;
			// A failed leg carries its target as a structured field, and its message is unchanged (find-search still reads it).
			ServerController.TickResult leg = ServerRetraceController.legStopped(ServerController.TickResult.failed("NO_ROUTE", "Could not get out of the water in 30 s", 0.2),
					1, 12, new dev.agaminggod.mineagen.server.perception.WalkedRoute.Point("minecraft:overworld", -8, 46, -43), 0.08);
			check(new BlockPos(-8, 46, -43).equals(leg.nextWaypoint()) && leg.state() == ServerController.State.FAILED && leg.reasonCode().equals("NO_ROUTE") && leg.progress() == 0.08,
					"a failed retrace leg names its target cell as nextWaypoint"); n++;
			check(leg.message().equals("Retrace 1/12 toward Point[dimension=minecraft:overworld, x=-8, y=46, z=-43]: Could not get out of the water in 30 s"),
					"a failed retrace leg keeps the message find-search parses: " + leg.message()); n++;
			check(ServerController.TickResult.failed("NO_ROUTE", "x", 0).nextWaypoint() == null && ServerController.TickResult.running(0.5).nextWaypoint() == null,
					"results without a waypoint have none"); n++;
		} catch (Exception failure) { throw new AssertionError(failure); }
		return n;
	}
	private static Object value(Object instance,String name) throws Exception { Field field=instance.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(instance); }
	private static void check(boolean ok,String why) { if(!ok) throw new AssertionError(why); }
}
