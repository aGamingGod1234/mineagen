package dev.agaminggod.arenaagents.control;

import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;

/** Shared visible and narrated text for the selected agent's latest decision. */
public final class LiveDecisionText {
 private LiveDecisionText() { }
 public static List<String> lines(JsonObject decision) {
  if (decision == null || decision.size() == 0) return List.of("Waiting for the selected agent's next decision.");
  List<String> lines = new ArrayList<>();
  String reasoning = value(decision, "reasoning");
  if (!reasoning.isBlank()) {
   String compact = reasoning.replaceAll("\\s+", " ").strip();
   int split = compact.length() > 130 ? compact.lastIndexOf(' ', 130) : -1;
   if (split > 50) { lines.add("Thinking: " + compact.substring(0, split)); lines.add(compact.substring(split + 1)); }
   else lines.add("Thinking: " + compact);
  }
  String action = value(decision, "action"), purpose = value(decision, "purpose");
  if (!action.isBlank()) lines.add("Action: " + action);
  if (reasoning.isBlank() && !purpose.isBlank()) lines.add("Purpose: " + purpose);
  if (lines.isEmpty()) lines.add("Waiting for the selected agent's next decision.");
  return List.copyOf(lines);
 }
 private static String value(JsonObject object, String key) {
  var value = object.get(key);
  return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString() ? value.getAsString() : "";
 }
}
