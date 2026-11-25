package dev.agaminggod.mineagen.server.perception;

public final class WalkedRouteVerification {
 public static int verify() {
  WalkedRoute r=new WalkedRoute();
  for(int x=0;x<=12;x++) r.step(p("ow",x,64,0),false);
  for(int z=1;z<=12;z++) r.step(p("ow",12,64,z),false);
  r.mark(p("ow",12,64,6),"seen lava nearby");
  r.disconnect();
  WalkedRoute.Path path=r.path(p("ow",0,64,0),p("ow",12,64,12));
  check(path!=null && path.length()==24,"death retains the long route");
  check(path.points().contains(p("ow",12,64,0)),"compaction keeps the corner instead of cutting a wall");
  check(path.hazards().contains("seen lava nearby"),"route hazards survive compaction");
  check(path.points().size()<25,"straight footsteps compact into waypoints");
  r.step(p("ow",100,64,100),false);
  check(r.path(p("ow",100,64,100),p("ow",12,64,12))==null,"respawn never creates a teleport edge");
  WalkedRoute n=new WalkedRoute();
  n.step(p("ow",0,64,0),false);n.step(p("ow",1,64,0),true);
  n.step(p("nether",10,64,0),false);n.step(p("nether",11,64,0),false);n.disconnect();
  check(n.path(p("ow",0,64,0),p("nether",11,64,0)).length()==2,"portal crossing preserves both walked legs");
  check(n.path(p("nether",11,64,0),p("ow",0,64,0))!=null,"Nether return portal is usable both ways");
  WalkedRoute e=new WalkedRoute();e.step(p("ow",0,64,0),true);e.step(p("minecraft:the_end",100,49,0),false);
  check(e.path(p("minecraft:the_end",100,49,0),p("ow",0,64,0))==null,"End arrival is not a return portal");
  WalkedRoute t=new WalkedRoute();t.step(p("ow",0,64,0),false);t.step(p("nether",0,64,0),false);
  check(t.path(p("ow",0,64,0),p("nether",0,64,0))==null,"a dimension teleport without portal contact is disconnected");
  WalkedRoute ladder=new WalkedRoute();
  for(int y=64;y<=68;y++) ladder.step(p("ow",0,y,0),false);
  check(ladder.path(p("ow",1,64,0),p("ow",0,68,0)).points().getFirst().y()==64,"a nearby vertical route joins at the reachable floor, not an elevated rung");
  WalkedRoute shaft=new WalkedRoute();shaft.step(p("ow",0,64,0),false);shaft.step(p("ow",0,63,0),false);shaft.step(p("ow",0,62,0),false);
  check(shaft.path(p("ow",0,62,0),p("ow",0,64,0)).hazards().stream().anyMatch(h->h.startsWith("shaft:")),"unit shaft steps retain the tools and blocks needed in reverse");
  n.step(p("ow",1,64,0),true);n.step(p("nether",10,64,1),false);
  check(n.path(p("nether",10,64,1),p("nether",11,64,0)).points().stream().allMatch(point->point.dimension().equals("nether")),"a shifted portal exit joins the nearby walked route instead of crossing twice");
  // A lower tunnel walked back under the upper one: the upper footstep straight overhead is the climb that saves the loop.
  WalkedRoute loop=new WalkedRoute();
  for(int z=0;z<=10;z++) loop.step(p("ow",0,70,z),false);
  for(int i=1;i<=6;i++) loop.step(p("ow",0,70-i,10+i),false);
  for(int z=15;z>=2;z--) loop.step(p("ow",0,64,z),false);
  java.util.List<WalkedRoute.Point> up=loop.columnShortcuts(p("ow",0,64,2),p("ow",0,70,0),12,4,java.util.Set.of());
  check(up.equals(java.util.List.of(p("ow",0,70,2))),"the upper tunnel overhead cuts the walked loop short");
  check(loop.columnShortcuts(p("ow",0,64,2),p("ow",0,70,0),12,4,java.util.Set.of(p("ow",0,70,2))).isEmpty(),"a refused column is not offered again");
  check(loop.columnShortcuts(p("ow",0,64,2),p("ow",0,70,0),5,4,java.util.Set.of()).isEmpty(),"a footstep higher than the climb limit is left out");
  // A shaft walked straight up saves nothing beyond its own climb, so the plain route stands.
  WalkedRoute straight=new WalkedRoute();
  for(int y=64;y<=70;y++) straight.step(p("ow",5,y,0),false);
  for(int x=6;x<=10;x++) straight.step(p("ow",x,70,0),false);
  check(straight.columnShortcuts(p("ow",5,64,0),p("ow",10,70,0),12,4,java.util.Set.of()).isEmpty(),"the walked shaft itself is no shortcut");
  // A stair dug down (step forward, then drop in place) is walked back up as diagonal steps, not a pillar per step.
  WalkedRoute stair=new WalkedRoute();
  for(int i=0;i<=6;i++) {stair.step(p("ow",0,70-i,i),false);stair.step(p("ow",0,70-i,i+1),false);}
  stair.step(p("ow",0,63,7),false);
  WalkedRoute.Path climb=stair.path(p("ow",0,63,7),p("ow",0,70,0));
  boolean straightUp=false;
  for(int i=1;i<climb.points().size();i++) {WalkedRoute.Point a=climb.points().get(i-1),b=climb.points().get(i);straightUp|=a.x()==b.x() && a.z()==b.z();}
  check(!straightUp,"no stair step is climbed straight up");
  check(climb.points().size()<=5,"the stair compacts into a few diagonal legs");
  WalkedRoute rungs=new WalkedRoute();
  for(int y=64;y<=68;y++) {rungs.step(p("ow",0,y,0),false);rungs.mark(p("ow",0,y,0),WalkedRoute.CLIMBABLE);}
  rungs.step(p("ow",1,68,0),false);
  check(rungs.path(p("ow",0,64,0),p("ow",1,68,0)).points().contains(p("ow",0,68,0)),"a ladder's top rung stays a waypoint");
  // A ledge walked, a 10-block fall 2 blocks out, then a walk on below: the trail before the fall is still the way back.
  WalkedRoute fell=new WalkedRoute();
  for(int x=0;x<=5;x++) fell.step(p("ow",x,70,0),false);
  for(int x=7;x<=10;x++) fell.step(p("ow",x,60,0),false);
  WalkedRoute.Path back=fell.path(p("ow",10,60,0),p("ow",0,70,0));
  check(back!=null,"a fall keeps the trail above it on the way back");
  int landing=back.points().indexOf(p("ow",7,60,0)), top=back.points().indexOf(p("ow",7,70,0));
  check(landing>=0 && top==landing+1 && back.points().get(top+1).y()==70 && back.points().get(top+1).x()<=5,"back up a fall: pillar over the landing, then step across to the ledge");
  check(back.hazards().stream().anyMatch(h->h.startsWith("fall: dropped 10 blocks")),"the fall names the blocks the climb back needs");
  WalkedRoute.Path down=fell.path(p("ow",0,70,0),p("ow",10,60,0));
  check(down!=null && !down.points().contains(p("ow",7,70,0)),"forward, the fall is the drop itself, not the pillar");
  check(!fell.path(p("ow",7,70,0),p("ow",0,70,0)).points().contains(p("ow",7,70,0)),"the pillar top over a landing is never where a retrace starts");
  WalkedRoute.Path toTop=fell.path(p("ow",10,60,0),p("ow",7,70,0));
  check(toTop!=null && toTop.points().getLast().equals(p("ow",5,70,0)),"the pillar top over a landing is never where a retrace ends");
  check(fell.path(p("ow",8,70,0),p("ow",0,70,0))==null,"beside the pillar top alone there is no entry yet");
  fell.disconnect();fell.step(p("ow",7,70,0),false);
  check(fell.path(p("ow",8,70,0),p("ow",0,70,0))!=null,"a pillar top the body stood on is a footstep like any other");
  WalkedRoute far=new WalkedRoute();
  far.step(p("ow",0,70,0),false);far.step(p("ow",12,67,0),false);
  check(far.path(p("ow",12,67,0),p("ow",0,70,0))==null,"a landing far beyond a fall's drift (a pearl, a knockback flight) stays unconnected");
  return 28;
 }
 private static WalkedRoute.Point p(String d,int x,int y,int z) {return new WalkedRoute.Point(d,x,y,z);}
 private static void check(boolean condition,String message) {if(!condition) throw new AssertionError(message);}
}
