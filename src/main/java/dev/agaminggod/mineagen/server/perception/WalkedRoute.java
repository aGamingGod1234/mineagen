package dev.agaminggod.mineagen.server.perception;

import java.util.*;

/** A graph of actual footsteps, never a map of unseen terrain. Disconnected lives do not invent an edge. */
public final class WalkedRoute {
 static final String CLIMBABLE="climbable route: no construction needed while ladder/vine is intact";
 public record Point(String dimension, int x, int y, int z) {
  public double distance(Point b) { return dimension.equals(b.dimension) ? Math.sqrt(Math.pow(x-b.x,2)+Math.pow(y-b.y,2)+Math.pow(z-b.z,2)) : Double.POSITIVE_INFINITY; }
 }
 public record Path(List<Point> points, double length, Set<String> hazards) {}
 private final Map<Point, Set<Point>> edges = new HashMap<>();
 private final Map<Point, Set<String>> hazards = new HashMap<>();
 private Point previous;
 private boolean portal;
 public void disconnect() { previous = null; portal = false; }
 public void step(Point at, boolean atPortal) {
  edges.computeIfAbsent(at, k -> new LinkedHashSet<>());
  if (previous != null && !previous.equals(at)) {
   if (previous.dimension.equals(at.dimension) && previous.distance(at) <= 5) connect(previous, at, true, !atPortal && !portal);
   else if (!previous.dimension.equals(at.dimension) && portal) {
    connect(previous, at, !at.dimension.equals("minecraft:the_end") && !previous.dimension.equals("minecraft:the_end"),false);
    mark(previous, "portal transition"); mark(at, "portal transition");
   }
  }
  previous = at; portal = atPortal;
 }
 private void connect(Point a, Point b, boolean reverse, boolean walked) {
  edges.get(a).add(b);
  if (reverse) edges.get(b).add(a);
  if (walked && a.dimension.equals(b.dimension) && a.x==b.x && a.z==b.z && a.y!=b.y) { mark(a,"shaft: existing ladder/water if intact; blocks to pillar up; water bucket and pickaxe to reopen downward"); mark(b,"shaft: existing ladder/water if intact; blocks to pillar up; water bucket and pickaxe to reopen downward"); }
  if (walked && a.dimension.equals(b.dimension) && a.distance(b)>1.75) { mark(a,"jump or gap: blocks may be needed on return"); mark(b,"jump or gap: blocks may be needed on return"); }
  if (walked && a.dimension.equals(b.dimension) && Math.abs(a.y-b.y)>1) { mark(a,"vertical step: blocks may be needed on return"); mark(b,"vertical step: blocks may be needed on return"); }
 }
 public void mark(Point at, String hazard) { hazards.computeIfAbsent(at, k -> new LinkedHashSet<>()).add(hazard); }
 public int size() { return edges.size(); }
 public boolean climbable(Point at) { return hazards.getOrDefault(at,Set.of()).contains(CLIMBABLE); }
 public Path path(Point from, Point target) {
  // The body must stand on the remembered route. A nearby tunnel behind a wall is not an entry.
  Point end = nearest(target, 2.5);
  if (end == null) return null;
  Map<Point, Double> costs = new HashMap<>(); Map<Point, Point> parent = new HashMap<>();
  record Pending(Point at, double cost) {}
  PriorityQueue<Pending> queue = new PriorityQueue<>(Comparator.comparingDouble(Pending::cost));
  // Portal exits and bed spawns vary within a small area. Join the nearby remembered route with ordinary local
  // travel rather than forcing an immediate round trip through the portal just crossed. Every joining leg still
  // needs fresh visible footing in the controller; this is not a claim that adjacent terrain is open.
  for(Point entry:edges.keySet()) {
   double gap=from.distance(entry);
   if(gap<=2.0 && entry.y==from.y) {costs.put(entry,gap);queue.add(new Pending(entry,gap));}
  }
  if(queue.isEmpty()) return null;
  while (!queue.isEmpty()) {
   Pending p=queue.remove();
   if (p.cost > costs.get(p.at)) continue;
   if (p.at.equals(end)) break;
   for (Point next: edges.get(p.at)) {
    double d=p.at.dimension.equals(next.dimension)?p.at.distance(next):8;
    double cost=p.cost+d;
    if (cost >= costs.getOrDefault(next,Double.POSITIVE_INFINITY)) continue;
    costs.put(next,cost); parent.put(next,p.at); queue.add(new Pending(next,cost));
   }
  }
  if (!costs.containsKey(end)) return null;
  List<Point> full=new ArrayList<>(); Set<String> risks=new LinkedHashSet<>();
  for (Point at=end; at!=null; at=parent.get(at)) { full.add(at); risks.addAll(hazards.getOrDefault(at,Set.of())); }
  Collections.reverse(full);
  // A dug stair is remembered as drop-in-place then step forward (or step then drop), so every stair step reads as a
  // straight-up waypoint. Walk it as the stair it is: drop the corner footstep when the body's way passes through the
  // corner's own open cells (rise in the corner's column then step out, or step into it then drop), never a ladder rung.
  List<Point> walk=new ArrayList<>();
  for (Point p: full) {
   if (walk.size()>=2 && stairCorner(walk.get(walk.size()-2),walk.getLast(),p) && !climbable(walk.getLast())) walk.removeLast();
   walk.add(p);
  }
  List<Point> compact=new ArrayList<>();
  for (Point p: walk) {
   if (compact.size()>=2) {
    Point a=compact.get(compact.size()-2),b=compact.getLast();
    if (a.dimension.equals(p.dimension) && b.dimension.equals(p.dimension) && a.distance(p)<=4
      && (b.x-a.x)*(p.z-b.z)==(b.z-a.z)*(p.x-b.x)
      && (b.y-a.y)*(p.x-b.x)==(b.x-a.x)*(p.y-b.y)
      && (b.y-a.y)*(p.z-b.z)==(b.z-a.z)*(p.y-b.y)
      && (b.x-a.x)*(p.x-b.x)+(b.y-a.y)*(p.y-b.y)+(b.z-a.z)*(p.z-b.z)>0) compact.removeLast();
   }
   compact.add(p);
  }
  double walked=from.distance(full.getFirst())+end.distance(target);
  for(int i=1;i<full.size();i++) if(full.get(i-1).dimension.equals(full.get(i).dimension)) walked+=full.get(i-1).distance(full.get(i));
  return new Path(List.copyOf(compact),walked,Set.copyOf(risks));
 }
 static boolean stairCorner(Point a,Point b,Point p) {
  if (!a.dimension.equals(b.dimension) || !b.dimension.equals(p.dimension)) return false;
  boolean up=a.x==b.x && a.z==b.z && b.y==a.y+1 && p.y==b.y && Math.abs(p.x-b.x)+Math.abs(p.z-b.z)==1;
  boolean down=a.y==b.y && Math.abs(a.x-b.x)+Math.abs(a.z-b.z)==1 && p.x==b.x && p.z==b.z && p.y==b.y-1;
  return up || down;
 }
 /**
  * Remembered footsteps straight above from (same column, at most maxRise higher) whose walked way on to the target is
  * shorter than from's by more than the climb to them plus margin: the stair seen overhead through a gap a later tunnel
  * opened, reached by pillaring instead of walking the loop round to it. Best saving first; skip lists points to leave out.
  */
 public List<Point> columnShortcuts(Point from, Point target, int maxRise, double margin, Set<Point> skip) {
  List<Point> above=new ArrayList<>();
  for(Point at:edges.keySet()) if(at.dimension.equals(from.dimension) && at.x==from.x && at.z==from.z && at.y>from.y && at.y-from.y<=maxRise && !skip.contains(at)) above.add(at);
  if(above.isEmpty()) return List.of();
  // One search backwards from the target's end covers every candidate: the walked cost from each footstep to it.
  Point end=nearest(target,2.5);
  if(end==null) return List.of();
  Map<Point,List<Point>> incoming=new HashMap<>();
  for(Map.Entry<Point,Set<Point>> e:edges.entrySet()) for(Point next:e.getValue()) incoming.computeIfAbsent(next,k->new ArrayList<>()).add(e.getKey());
  Map<Point,Double> toEnd=new HashMap<>();
  record Pending(Point at,double cost) {}
  PriorityQueue<Pending> queue=new PriorityQueue<>(Comparator.comparingDouble(Pending::cost));
  toEnd.put(end,0.0);queue.add(new Pending(end,0.0));
  while(!queue.isEmpty()) {
   Pending p=queue.remove();
   if(p.cost>toEnd.get(p.at)) continue;
   for(Point prev:incoming.getOrDefault(p.at,List.of())) {
    double cost=p.cost+(prev.dimension.equals(p.at.dimension)?prev.distance(p.at):8);
    if(cost>=toEnd.getOrDefault(prev,Double.POSITIVE_INFINITY)) continue;
    toEnd.put(prev,cost);queue.add(new Pending(prev,cost));
   }
  }
  double here=walkedFrom(from,toEnd);
  if(!Double.isFinite(here)) return List.of();
  record Saving(Point at,double saved) {}
  List<Saving> found=new ArrayList<>();
  for(Point at:above) {
   double saved=here-walkedFrom(at,toEnd)-(at.y-from.y);
   if(saved>margin) found.add(new Saving(at,saved));
  }
  found.sort(Comparator.comparingDouble(Saving::saved).reversed());
  List<Point> out=new ArrayList<>();
  for(Saving s:found) out.add(s.at());
  return out;
 }
 /** The walked cost from a standing point to the search's end, joining the route as path() does (same height, within 2). */
 private double walkedFrom(Point from,Map<Point,Double> toEnd) {
  double best=Double.POSITIVE_INFINITY;
  for(Point entry:edges.keySet()) {
   double gap=from.distance(entry);
   Double rest=toEnd.get(entry);
   if(gap<=2.0 && entry.y==from.y && rest!=null) best=Math.min(best,gap+rest);
  }
  return best;
 }
 private Point nearest(Point p,double limit) {
  if (edges.containsKey(p)) return p;
  Point best=null; double d=limit;
  for (Point at:edges.keySet()) { double next=at.distance(p); if(next<d) {d=next;best=at;} }
  return best;
 }
}
