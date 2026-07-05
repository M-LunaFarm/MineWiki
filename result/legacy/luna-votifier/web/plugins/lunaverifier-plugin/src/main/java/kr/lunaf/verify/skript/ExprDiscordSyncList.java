package kr.lunaf.verify.skript;

import ch.njol.skript.lang.Expression;
import ch.njol.skript.lang.SkriptParser;
import ch.njol.skript.lang.util.SimpleExpression;
import ch.njol.util.Kleenean;
import java.util.List;
import kr.lunaf.verify.DiscordSyncEntry;
import kr.lunaf.verify.LunaVotifierPlugin;
import org.bukkit.event.Event;

public class ExprDiscordSyncList extends SimpleExpression<String> {
  @Override
  public boolean init(Expression<?>[] exprs, int matchedPattern, Kleenean isDelayed, SkriptParser.ParseResult parseResult) {
    return true;
  }

  @Override
  protected String[] get(Event event) {
    final LunaVotifierPlugin plugin = LunaVotifierPlugin.getInstance();
    if (plugin == null) {
      return new String[0];
    }
    final List<DiscordSyncEntry> entries = plugin.getDiscordSyncList();
    final String[] values = new String[entries.size()];
    for (int i = 0; i < entries.size(); i++) {
      final DiscordSyncEntry entry = entries.get(i);
      values[i] = entry != null ? entry.getMcUuid() : "";
    }
    return values;
  }

  @Override
  public boolean isSingle() {
    return false;
  }

  @Override
  public Class<? extends String> getReturnType() {
    return String.class;
  }

  @Override
  public String toString(Event event, boolean debug) {
    return "discord sync list";
  }
}
