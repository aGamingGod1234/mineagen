package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.server.perception.RouteMemory;
import dev.agaminggod.mineagen.server.perception.WalkedRoute;
import java.util.function.BiPredicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;

/** Follows remembered turns; each leg uses ordinary travel's current sight, lava brake, brink and construction. */
public final class ServerRetraceController implements ServerController {
 private final String dimension;
 private final double x,y,z,tolerance;
 private final long timeoutMs,startedAt;
 private final boolean build;
 private final String stop;
 private final Float health;
 private final BiPredicate<ServerPlayer,BlockPos> modify;
 private WalkedRoute.Path path;
 private int index,legEnd;
 private boolean lookedOut;
 private ServerController leg;
 private final java.util.function.IntFunction<ServerController> shaft;
 private ServerNavigationController portalLeg;
 private long portalSince;
 private double startRemaining = Double.NaN;
 private String resumeArguments;
 private static final org.slf4j.Logger LOGGER=org.slf4j.LoggerFactory.getLogger(ServerRetraceController.class);
 /** Column shortcut: how high a remembered footstep overhead may be, the route it must save, and the look up to see the gap. */
 static final int SHORTCUT_RISE=12, SHORTCUT_LOOK_TICKS=30;
 static final double SHORTCUT_MARGIN=4.0D;
 private final java.util.Set<WalkedRoute.Point> shortcutRefused=new java.util.HashSet<>();
 private java.util.List<WalkedRoute.Point> shortcuts=java.util.List.of();
 private WalkedRoute.Point shortcut,shortcutsFrom;
 private WalkedRoute.Path beforeShortcut;
 private int beforeIndex;
 private int shortcutLook;
 private int buriedChecks;
 public ServerRetraceController resumeWith(String arguments) { resumeArguments=arguments; return this; }

 public ServerRetraceController(String dimension,double x,double y,double z,double tolerance,long timeoutMs,boolean build,String stop,Float health,BiPredicate<ServerPlayer,BlockPos> modify,java.util.function.IntFunction<ServerController> shaft,long startedAt) {
  this.dimension=dimension;this.x=x;this.y=y;this.z=z;this.tolerance=tolerance;this.timeoutMs=timeoutMs;this.build=build;this.stop=stop;this.health=health;this.modify=modify;this.shaft=shaft;this.startedAt=startedAt;
 }
 @Override public TickResult tick(ServerPlayer p,long nowEpochMs) {
  if(path==null) {
   path=RouteMemory.of(p).path(p,dimension,x,y,z);
   // After a climb up a column the route is rebuilt from wherever the body ended; with no footing there yet, keep
   // following the walked route it had (its arrival checks pick up from the body's new place).
   if(path==null && beforeShortcut!=null) {path=beforeShortcut;index=beforeIndex;legEnd=beforeIndex;}
   beforeShortcut=null;
   if(path==null) return TickResult.failed("NO_ROUTE","No walked route connects this position to the target; no straight-line replacement attempted",0);
  }
  if(Double.isNaN(startRemaining)) startRemaining=remaining(p);
  if(nowEpochMs - startedAt >= timeoutMs) return TickResult.timedOut("TRAVEL_TIMEOUT",timeoutMessage(p, "Retrace deadline reached"),progress());
  while(index<path.points().size()) {
   WalkedRoute.Point next=path.points().get(index);
   if(!next.dimension().equals(RouteMemory.point(p).dimension()) || index+1<path.points().size() && !next.dimension().equals(path.points().get(index+1).dimension())) {
    if (leg!=null) {leg.cancel(p);leg=null;}
    WalkedRoute.Point source=next.dimension().equals(RouteMemory.point(p).dimension()) ? next : path.points().get(index-1);
    if(portalLeg==null) {
     portalSince=nowEpochMs;
     portalLeg=new ServerNavigationController(new net.minecraft.world.phys.Vec3(source.x()+0.5,source.y(),source.z()+0.5),0.2,false,nowEpochMs,Math.min(20_000,timeoutMs-(nowEpochMs-startedAt)));
    }
    TickResult crossing=portalLeg.tick(p,nowEpochMs);
    if(crossing.state()==State.RUNNING) return TickResult.running(progress());
    if(crossing.state()!=State.SUCCEEDED) return new TickResult(crossing.state(),crossing.reasonCode(),"Retrace portal: "+crossing.message(),progress());
    // Nether portals take four seconds of contact; hold still after navigation releases its inputs.
    portalLeg.cancel(p);
    if(nowEpochMs-portalSince>15_000) return TickResult.failed("NO_ROUTE","Remembered portal reached but no crossing occurred; inspect the current portal",progress());
    return TickResult.running(progress());
   }
   WalkedRoute.Point following=index+1<path.points().size()?path.points().get(index+1):null;
   boolean verticalNext=following!=null && next.dimension().equals(following.dimension()) && next.x()==following.x() && next.z()==following.z() && next.y()!=following.y();
   double arrival=verticalNext && !p.onClimbable()?0.3:1.15;
   double d=Math.sqrt(Math.pow(p.getX()-(next.x()+0.5),2)+Math.pow(p.getY()-next.y(),2)+Math.pow(p.getZ()-(next.z()+0.5),2));
   if(shortcut==null && (leg==null || legEnd==index) && d<=arrival && Math.abs(p.getY()-next.y())<=0.6) { if(leg!=null) leg.cancel(p);leg=null;lookedOut=false;index++;continue; }
   if(leg==null && shortcut==null && !lookedOut && skipBuriedEnabled() && buried(p,next)) {
    if(ServerTravelController.DEBUG) LOGGER.info("RETRACE_BURIED {}/{} {} is filled in; heading for the next footstep",index,path.points().size(),next);
    index++;continue;
   }
   if(leg==null && !lookedOut) {
    TickResult looking=startShortcut(p,nowEpochMs);
    if(looking!=null) return looking;
   }
   if(leg==null) {
    if(!lookedOut) legEnd=index;
    WalkedRoute.Point feet=RouteMemory.point(p);
    boolean rememberedClimb=RouteMemory.of(p).climbable(next);
    if(!lookedOut && rememberedClimb && (verticalNext || next.y()!=feet.y())) {
     while(legEnd+1<path.points().size()) {
      WalkedRoute.Point rung=path.points().get(legEnd+1);
      if(!rung.dimension().equals(next.dimension()) || rung.x()!=next.x() || rung.z()!=next.z()) break;
      legEnd++;
     }
     // Ordinary navigation ends on support, so continue through the rungs to the remembered landing.
     if(legEnd+1<path.points().size() && path.points().get(legEnd+1).dimension().equals(next.dimension()) && Math.abs(path.points().get(legEnd+1).y()-path.points().get(legEnd).y())<=1) legEnd++;
    }
    WalkedRoute.Point target=path.points().get(legEnd);
    double horizontal=Math.hypot(target.x()+0.5-p.getX(),target.z()+0.5-p.getZ());
    boolean alignVertical=verticalNext && Math.abs(p.getY()-target.y())<=0.6;
    boolean navigate=lookedOut || rememberedClimb || p.onClimbable() || alignVertical;
    // First see the remembered ladder from adjacent ground; the navigation goal is its supported landing.
    if(rememberedClimb && !p.onClimbable() && !lookedOut) {
     if(!ServerLookController.turnToward(p,new net.minecraft.world.phys.Vec3(next.x()+0.5,p.getY()+1.0,next.z()+0.5))) return TickResult.running(progress());
    } else if(navigate && horizontal>0.4 && Math.abs(p.getY()-target.y())<=2 && !ServerLookController.turnToward(p,new net.minecraft.world.phys.Vec3(target.x()+0.5,target.y()+1.0,target.z()+0.5))) return TickResult.running(progress());
    boolean down=target.y()<p.getY()-0.6 && horizontal<0.8;
    if(ServerTravelController.DEBUG) LOGGER.info("RETRACE_LEG {}..{}/{} from {} to {} by {}",index,legEnd,path.points().size(),RouteMemory.point(p),target,navigate?"navigation":down && build?"shaft down":"travel");
    leg=navigate ? new ServerNavigationController(new net.minecraft.world.phys.Vec3(target.x()+0.5,target.y(),target.z()+0.5),verticalNext?0.2:0.3,false,nowEpochMs,timeoutMs-(nowEpochMs-startedAt)) : down && build ? shaft.apply(target.y()) : new ServerTravelController(target.x()+0.5,target.y(),target.z()+0.5,1,timeoutMs-(nowEpochMs-startedAt),build,stop,health,modify,nowEpochMs).routeLeg();
   }
   TickResult result=leg.tick(p,nowEpochMs);
   // From the old floor the inside of a fill is unseen; walking up onto it shows the footstep is gone.
   boolean passBuried=shortcut==null && legEnd==index && skipBuriedEnabled();
   if(result.state()==State.RUNNING) {
    // A lava retreat, its watch or a fight report RUNNING; cutting them would drop the escape and its warning.
    if(!passBuried || leg instanceof ServerTravelController travel && travel.inSafetyRecovery() || ++buriedChecks%10!=0 || !buried(p,next)) return TickResult.running(progress());
    result=null;
   }
   leg.cancel(p);leg=null;
   // Only a leg that could not get there is passed on; damage, health, food and hostile stops still go back to the model.
   if(passBuried && (result==null || result.state()!=State.SUCCEEDED && BURIED_LEG_STOPS.contains(result.reasonCode())) && buried(p,next)) {
    if(ServerTravelController.DEBUG) LOGGER.info("RETRACE_BURIED {}/{} {} is filled in; leg {}",index,path.points().size(),next,result==null?"cut short":"stopped "+result.reasonCode());
    lookedOut=false;index++;continue;
   }
   if(result==null) return TickResult.running(progress());
   if(shortcut!=null) {
    WalkedRoute.Point took=shortcut;shortcut=null;
    if(result.reasonCode().equals("TRAVEL_TIMEOUT")) return TickResult.timedOut("TRAVEL_TIMEOUT",timeoutMessage(p, result.message()),progress());
    boolean arrived=result.state()==State.SUCCEEDED && (result.reasonCode().equals("ARRIVED") || result.reasonCode().equals("DESTINATION_REACHED"));
    if(!arrived && !SHORTCUT_GIVE_UP.contains(result.reasonCode())) return legStopped(result,index,path.points().size(),took,progress());
    if(!arrived) shortcutRefused.add(took);
    if(ServerTravelController.DEBUG) LOGGER.info("RETRACE_SHORTCUT {} {} {}",arrived?"climbed to":"gave up on",took,arrived?"":result.reasonCode()+" "+result.message());
    // The walked route from here, wherever the climb ended: the body's own footsteps up the column are on it.
    beforeShortcut=path;beforeIndex=index;path=null;index=0;legEnd=0;lookedOut=false;
    return TickResult.running(progress());
   }
   WalkedRoute.Point completed=path.points().get(legEnd);
   if(result.reasonCode().equals("REACHED_FRONTIER") && legEnd>index && !lookedOut && Math.abs(p.getY()-completed.y())<=2) {lookedOut=true;return TickResult.running(progress());}
   if(result.reasonCode().equals("TRAVEL_TIMEOUT")) return TickResult.timedOut("TRAVEL_TIMEOUT",timeoutMessage(p, result.message()),progress());
   if(result.state()!=State.SUCCEEDED) return legStopped(result,index,path.points().size(),completed,progress());
   if(!result.reasonCode().equals("ARRIVED") && !result.reasonCode().equals("DESTINATION_REACHED")) return result;
   if(legEnd==index && d>1.75 && Math.abs(p.getY()-next.y())>1.2) return TickResult.failed("NO_ROUTE","Remembered vertical step needs rebuilding; waypoint "+next,progress()).withNextWaypoint(cell(next));
   index=legEnd+1;lookedOut=false;
  }
  // A death can be between sampled footsteps. Finish the short last leg with normal travel's arrival band.
  if(Math.hypot(p.getX()-x,p.getZ()-z)>tolerance || Math.abs(p.getY()-y)>Math.max(3,tolerance)) {
   if(leg==null) leg=new ServerTravelController(x,y,z,tolerance,timeoutMs-(nowEpochMs-startedAt),build,stop,health,modify,nowEpochMs);
   TickResult result=leg.tick(p,nowEpochMs);
   if(result.state()==State.RUNNING) return TickResult.running(progress());
   leg.cancel(p);leg=null;
   if(result.reasonCode().equals("TRAVEL_TIMEOUT")) return TickResult.timedOut("TRAVEL_TIMEOUT",timeoutMessage(p, result.message()),progress());
   if(result.state()!=State.SUCCEEDED || !result.reasonCode().equals("ARRIVED")) return result;
  }
  return TickResult.succeeded("ARRIVED","Retraced "+Math.round(path.length())+" blocks along "+path.points().size()+" remembered waypoints; target "+x+","+y+","+z);
 }
 /**
  * A remembered footstep whose feet or head cell is now seen as a full solid block: the bot's own stair steps placed over
  * an old tunnel, a filled hole, fallen gravel. Nobody can stand there any more, and a leg aimed at it ended on the block
  * above and stalled for 60 s, so retrace goes on to the next footstep as a player walks the way the ground now runs.
  */
 private static boolean buried(ServerPlayer p,WalkedRoute.Point at) {
  if(!at.dimension().equals(RouteMemory.point(p).dimension()) || RouteMemory.of(p).climbable(at)) return false;
  MinecraftNavigationWorld seen=new MinecraftNavigationWorld(p.level(),p);
  return buriedCells(fullBlock(seen,p,new BlockPos(at.x(),at.y(),at.z())),fullBlock(seen,p,new BlockPos(at.x(),at.y()+1,at.z())));
 }
 static boolean buriedCells(Boolean feetFull,Boolean headFull) {return Boolean.TRUE.equals(feetFull) || Boolean.TRUE.equals(headFull);}
 /** True for a seen full block, false for a seen cell that is not one, null for an unseen cell. */
 private static Boolean fullBlock(MinecraftNavigationWorld seen,ServerPlayer p,BlockPos cell) {
  net.minecraft.world.level.block.state.BlockState state=seen.stateAt(cell);
  if(state==null) return null;
  return state.getFluidState().isEmpty() && net.minecraft.world.level.block.Block.isShapeFullBlock(state.getCollisionShape(p.level(),cell));
 }
 /** Leg stops that mean the footstep could not be reached, the only ones a filled-in footstep may explain. */
 static final java.util.Set<String> BURIED_LEG_STOPS=java.util.Set.of("NO_ROUTE","STALLED_IN_PLACE","PATH_BLOCKED","REACHED_FRONTIER","NO_SEEN_ROUTE","NO_STANDABLE_PATH");
 static boolean skipBuriedEnabled() {return dev.agaminggod.mineagen.server.Switches.get("travel.skipBuried");}
 /** Shortcut leg stops that only mean this column does not work: the walked route is still there to follow. */
 static final java.util.Set<String> SHORTCUT_GIVE_UP=java.util.Set.of("NO_ROUTE","BUILD_FAILED","OUT_OF_BLOCKS","TUNNEL_FLOODED","TUNNEL_LAVA_PLUGGED","ORE_TOOL_REQUIRED","NO_TOOL","TOOL_WORN","PATH_BLOCKED","STALLED_IN_PLACE","SURFACE_NOT_FOUND");

 /**
  * A remembered footstep straight overhead (its stair, seen through a gap a later tunnel opened) whose way on is much
  * shorter than the walked loop round to it: look up the gap once and pillar straight to it when every cell up to its
  * headroom is seen open, dry and away from seen lava, as a player climbs to the step they see above them. Returns a
  * running result while looking up, null otherwise (with leg set when the shortcut is taken).
  */
 private TickResult startShortcut(ServerPlayer p,long nowEpochMs) {
  if(!build || p.onClimbable() || TravelBuilder.blockSlot(p)<0) return null;
  WalkedRoute.Point feet=RouteMemory.point(p);
  if(!feet.dimension().equals(dimension)) return null;
  if(!feet.equals(shortcutsFrom)) {
   shortcutsFrom=feet;shortcutLook=0;
   shortcuts=RouteMemory.of(p).columnShortcuts(p,dimension,x,y,z,SHORTCUT_RISE,SHORTCUT_MARGIN,shortcutRefused);
  }
  if(shortcuts.isEmpty()) return null;
  MinecraftNavigationWorld seen=new MinecraftNavigationWorld(p.level(),p);
  boolean unseen=false;String refusal=null;
  for(WalkedRoute.Point at:shortcuts) {
   String why=columnRefusal(seen,p,feet,at);
   if(why==null) {
    shortcut=at;shortcuts=java.util.List.of();
    if(ServerTravelController.DEBUG) LOGGER.info("RETRACE_SHORTCUT from {} pillar to {}",feet,at);
    leg=new ServerTravelController(at.x()+0.5,at.y(),at.z()+0.5,1,timeoutMs-(nowEpochMs-startedAt),build,stop,health,modify,nowEpochMs).routeLeg();
    return null;
   }
   if(why.startsWith("unseen")) unseen=true;
   if(refusal==null) refusal=why;
  }
  if(unseen && shortcutLook++<SHORTCUT_LOOK_TICKS) {
   ServerLookController.turnToward(p,new net.minecraft.world.phys.Vec3(feet.x()+0.5,p.getEyeY()+8.0,feet.z()+0.5));
   return TickResult.running(progress());
  }
  if(ServerTravelController.DEBUG) LOGGER.info("RETRACE_SHORTCUT from {} refused: {}",feet,refusal);
  shortcutRefused.addAll(shortcuts);shortcuts=java.util.List.of();
  return null;
 }
 /** Why the column from the feet up to the footstep's headroom cannot be pillared, or null when it is seen open. */
 static String columnRefusal(MinecraftNavigationWorld seen,ServerPlayer p,WalkedRoute.Point feet,WalkedRoute.Point at) {
  for(int cy=feet.y()+1;cy<=at.y()+1;cy++) {
   BlockPos cell=new BlockPos(feet.x(),cy,feet.z());
   net.minecraft.world.level.block.state.BlockState state=seen.stateAt(cell);
   if(state==null) return "unseen "+cell.toShortString();
   if(!state.getFluidState().isEmpty()) return "fluid at "+cell.toShortString();
   if(!state.getCollisionShape(p.level(),cell).isEmpty()) return "blocked at "+cell.toShortString();
   if(TravelBuilder.seenLavaBeside(seen,cell)) return "lava beside "+cell.toShortString();
  }
  return null;
 }
 /** A leg that stopped short: its own state and reason, the leg target in the message as before and as nextWaypoint. */
 static TickResult legStopped(TickResult result,int index,int count,WalkedRoute.Point target,double progress) {
  return new TickResult(result.state(),result.reasonCode(),"Retrace "+index+"/"+count+" toward "+target+": "+result.message(),progress).withNextWaypoint(cell(target));
 }
 private static BlockPos cell(WalkedRoute.Point point) {return new BlockPos(point.x(),point.y(),point.z());}
 private double remaining(ServerPlayer p) {
  WalkedRoute.Point from=RouteMemory.point(p);
  double total=0;
  double fx=p.getX(),fy=p.getY(),fz=p.getZ();String dim=from.dimension();
  for(int i=index;i<path.points().size();i++) {
   WalkedRoute.Point next=path.points().get(i);
   if(dim.equals(next.dimension())) total+=Math.sqrt(Math.pow(next.x()+0.5-fx,2)+Math.pow(next.y()-fy,2)+Math.pow(next.z()+0.5-fz,2));
   fx=next.x()+0.5;fy=next.y();fz=next.z()+0.5;dim=next.dimension();
  }
  if(dim.equals(dimension)) total+=Math.sqrt(Math.pow(x-fx,2)+Math.pow(y-fy,2)+Math.pow(z-fz,2));
  return total;
 }
 private String timeoutMessage(ServerPlayer p,String why) {
  double left=remaining(p);
  String args=resumeArguments==null ? "{x:"+x+",y:"+y+",z:"+z+",retrace:true,timeoutMs:"+timeoutMs+"}" : resumeArguments;
  String text=timeoutText(why,index,path.points().size(),p.getX(),p.getY(),p.getZ(),startRemaining-left,left,args);
  cancel(p);return text;
 }
 static String timeoutText(String why,int done,int count,double x,double y,double z,double covered,double left,String args) {
  return String.format(java.util.Locale.ROOT,"%s; completed %d/%d waypoints; at %.1f,%.1f,%.1f; covered %.1f route blocks; %.1f route blocks remaining including final approach",why,done,count,x,y,z,covered,left);
 }
 private double progress() {return path==null?0:Math.min(0.99,(double)index/Math.max(1,path.points().size()));}
 @Override public void cancel(ServerPlayer p) {if(leg!=null) leg.cancel(p);if(portalLeg!=null) portalLeg.cancel(p);}
}
