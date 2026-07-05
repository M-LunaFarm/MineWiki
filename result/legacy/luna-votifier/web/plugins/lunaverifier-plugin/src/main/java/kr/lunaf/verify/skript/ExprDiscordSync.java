package kr.lunaf.verify.skript;

import ch.njol.skript.lang.Expression;
import ch.njol.skript.lang.SkriptParser;
import ch.njol.skript.lang.util.SimpleExpression;
import ch.njol.util.Kleenean;
import kr.lunaf.verify.LunaVotifierPlugin;
import org.bukkit.entity.Player;
import org.bukkit.event.Event;

public class ExprDiscordSync extends SimpleExpression<Boolean> {
  private Expression<Player> playerExpr;

  @Override
  public boolean init(Expression<?>[] exprs, int matchedPattern, Kleenean isDelayed, SkriptParser.ParseResult parseResult) {
    playerExpr = (Expression<Player>) exprs[0];
    return true;
  }

  @Override
  protected Boolean[] get(Event event) {
    final Player player = playerExpr.getSingle(event);
    if (player == null) {
      return new Boolean[] { false };
    }
    final LunaVotifierPlugin plugin = LunaVotifierPlugin.getInstance();
    if (plugin == null) {
      return new Boolean[] { false };
    }
    return new Boolean[] { plugin.isDiscordSync(player) };
  }

  @Override
  public boolean isSingle() {
    return true;
  }

  @Override
  public Class<? extends Boolean> getReturnType() {
    return Boolean.class;
  }

  @Override
  public String toString(Event event, boolean debug) {
    return "discord sync of player";
  }
}
