package kr.lunaf.verify.skript;

import ch.njol.skript.lang.Expression;
import ch.njol.skript.lang.SkriptParser;
import ch.njol.skript.lang.util.SimpleExpression;
import ch.njol.util.Kleenean;
import kr.lunaf.verify.DiscordSyncEntry;
import kr.lunaf.verify.LunaVotifierPlugin;
import org.bukkit.entity.Player;
import org.bukkit.event.Event;

public class ExprDiscordSyncField extends SimpleExpression<String> {
  private Expression<Player> playerExpr;
  private int fieldIndex;

  @Override
  public boolean init(Expression<?>[] exprs, int matchedPattern, Kleenean isDelayed, SkriptParser.ParseResult parseResult) {
    playerExpr = (Expression<Player>) exprs[0];
    fieldIndex = matchedPattern;
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
    final String value = resolveField(entry);
    if (value == null || value.isBlank()) {
      return new String[0];
    }
    return new String[] { value };
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
    return "discord sync field of player";
  }

  private String resolveField(DiscordSyncEntry entry) {
    switch (fieldIndex) {
      case 0:
        return entry.getMcUuid();
      case 1:
        return entry.getMcIgn();
      case 2:
        return entry.getDiscordUserId();
      case 3:
        return entry.getGuildId();
      case 4:
        return entry.getOccurredAt();
      case 5:
        return entry.getVerifiedAt();
      default:
        return null;
    }
  }
}
