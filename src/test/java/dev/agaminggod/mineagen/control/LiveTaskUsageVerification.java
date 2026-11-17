package dev.agaminggod.mineagen.control;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.lang.reflect.Method;
import javax.swing.JLabel;
import javax.swing.plaf.basic.BasicHTML;

/** Uses invented token totals with a 75% cache ratio; no account capture. Checks the real terminal footer's usage semantics without opening a window. */
public final class LiveTaskUsageVerification {
 private LiveTaskUsageVerification() { }
 public static int verify() throws Exception {
  Class<?> windows=Class.forName("dev.agaminggod.mineagen.client.control.LiveAgentWindows");
  Method formatter=windows.getDeclaredMethod("usageText",JsonObject.class);formatter.setAccessible(true);
  JsonObject root=JsonParser.parseString("""
   {"usage":{"inputTokens":120000,"cachedInputTokens":90000,"uncachedInputTokens":30000,"outputTokens":3000,
    "lastInputTokens":40000,"lastCachedInputTokens":30000,"lastUncachedInputTokens":10000,"lastOutputTokens":200,
    "observedElapsedMs":60000,"inputTokensPerMinute":60000,"cachedInputTokensPerMinute":45000,"uncachedInputTokensPerMinute":15000,"outputTokensPerMinute":1500},
    "allowance":{"secondary":{"usedPercent":93,"windowDurationMins":10080}}}
   """).getAsJsonObject();
  String text=(String)formatter.invoke(null,root);
  int checks=0;
  checks+=contains(text,"Thread totals · Input 120,000 (includes cache)");
  checks+=contains(text,"Uncached 30,000");checks+=contains(text,"Cached 90,000 (75.0%)");
  checks+=contains(text,"Latest model input 40,000 (includes cache)");checks+=contains(text,"Uncached 10,000");
  checks+=contains(text,"Tokens/min (last 60.0 s sample)");checks+=contains(text,"Uncached 15,000");
  checks+=contains(text,"Shared 10,080 min: 7.0% left");
  JLabel label=new JLabel(text);if(label.getClientProperty(BasicHTML.propertyKey)==null)throw new AssertionError("Usage footer must render multiple readable lines");checks++;
  if(label.getPreferredSize().height<=new JLabel("One line").getPreferredSize().height)throw new AssertionError("Usage lines collapsed into one clipped footer");checks++;

  JsonObject usage=root.getAsJsonObject("usage");
  for(String field:new String[]{"lastInputTokens","lastCachedInputTokens","lastUncachedInputTokens","lastOutputTokens"})usage.remove(field);
  usage.addProperty("intervalInputTokens",60000);usage.addProperty("intervalCachedInputTokens",45000);usage.addProperty("intervalUncachedInputTokens",15000);usage.addProperty("intervalOutputTokens",1500);
  String sampled=(String)formatter.invoke(null,root);checks+=contains(sampled,"Between usage updates · Input 60,000 (includes cache)");
  if(sampled.contains("Latest model input"))throw new AssertionError("A cumulative usage interval is not a provider-reported model segment");checks++;

  usage.remove("observedElapsedMs");String noRate=(String)formatter.invoke(null,root);checks+=contains(noRate,"Rate pending two timed usage updates");
  if(noRate.contains("Tokens/min"))throw new AssertionError("A rate requires a positive timed interval");checks++;
  usage.addProperty("observedElapsedMs",0);checks+=contains((String)formatter.invoke(null,root),"Rate pending two timed usage updates");

  JsonObject legacy=JsonParser.parseString("{\"usage\":{\"inputTokens\":1000,\"cachedInputTokens\":900,\"outputTokens\":10},\"allowance\":null}").getAsJsonObject();
  checks+=contains((String)formatter.invoke(null,legacy),"Uncached 100");
  checks+=contains((String)formatter.invoke(null,JsonParser.parseString("{\"usage\":null,\"allowance\":null}").getAsJsonObject()),"Usage unavailable");
  JsonObject zero=JsonParser.parseString("{\"usage\":{\"inputTokens\":0,\"cachedInputTokens\":0,\"outputTokens\":0},\"allowance\":null}").getAsJsonObject();
  String zeroText=(String)formatter.invoke(null,zero);if(zeroText.contains("NaN")||zeroText.contains("Infinity"))throw new AssertionError("Empty token totals have no cache ratio");checks++;
  return checks;
 }
 private static int contains(String actual,String expected) { if(!actual.contains(expected))throw new AssertionError("Missing usage text: "+expected+" in "+actual);return 1; }
}
