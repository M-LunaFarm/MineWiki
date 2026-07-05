package kr.lunaf.verify.skript;

import ch.njol.skript.lang.Expression;
import ch.njol.skript.lang.SkriptParser;
import ch.njol.skript.lang.util.SimpleExpression;
import ch.njol.util.Kleenean;
import com.google.gson.Gson;
import java.util.LinkedHashMap;
import java.util.Map;
import kr.lunaf.verify.DiscordSyncEntry;
import kr.lunaf.verify.LunaVotifierPlugin;
import org.bukkit.entity.Player;
import org.bukkit.event.Event;

public class ExprDiscordSyncEntry extends SimpleExpression<String> {
  private static final Gson GSON = new Gson();
  private Expression<Player> playerExpr;

  @Override
  public boolean init(Expression<?>[] exprs, int matchedPattern, Kleenean isDelayed, SkriptParser.ParseResult parseResult) {
    playerExpr = (Expression<Player>) exprs[0];
    return true;
  }

  @Override
  protected String[] get(Event event) {
    final Player player = playerExpr.getSingle(event);
    if (player == null) {
      return new String[0];
    }
    final LunaVotifierPlugin plugin = LunaVotifierPlugin.getInstance();
    if (plugin == null) {
      return new String[0];
    }
    final DiscordSyncEntry entry = plugin.getDiscordSyncEntry(player);
    if (entry == null) {
      return new String[0];
    }
    final Map<String, String> data = new LinkedHashMap<>();
    data.put("mc_uuid", entry.getMcUuid());
    data.put("mc_ign", entry.getMcIgn());
    data.put("discord_user_id", entry.getDiscordUserId());
    data.put("guild_id", entry.getGuildId());
    data.put("occurred_at", entry.getOccurredAt());
    data.put("verified_at", entry.getVerifiedAt());
    return new String[] { GSON.toJson(data) };
  }

  @Override
  public boolean isSingle() {
    return true;
  }

  @Override
  public Class<? extends String> getReturnType() {
    return String.class;
  }

  @Override
  public String toString(Event event, boolean debug) {
    return "discord sync entry of player";
  }
}
