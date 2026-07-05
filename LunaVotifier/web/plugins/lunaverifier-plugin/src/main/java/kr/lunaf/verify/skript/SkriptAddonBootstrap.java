package kr.lunaf.verify.skript;

import ch.njol.skript.Skript;
import ch.njol.skript.lang.ExpressionType;
import kr.lunaf.verify.LunaVotifierPlugin;

public final class SkriptAddonBootstrap {
  private SkriptAddonBootstrap() {}

  public static void register(LunaVotifierPlugin plugin) {
    Skript.registerAddon(plugin);
    Skript.registerExpression(
      ExprDiscordSync.class,
      Boolean.class,
      ExpressionType.PROPERTY,
      "discord sync[ed] of %player%",
      "discord sync[ed] %player%"
    );
    Skript.registerExpression(
      ExprDiscordSyncList.class,
      String.class,
      ExpressionType.SIMPLE,
      "discord sync list",
      "discord sync uuid list"
    );
    Skript.registerExpression(
      ExprDiscordSyncEntry.class,
      String.class,
      ExpressionType.PROPERTY,
      "discord sync entry of %player%",
      "discord sync entry %player%"
    );
    Skript.registerExpression(
      ExprDiscordSyncField.class,
      String.class,
      ExpressionType.PROPERTY,
      "discord sync uuid of %player%",
      "discord sync ign of %player%",
      "discord sync discord id of %player%",
      "discord sync guild id of %player%",
      "discord sync occurred at of %player%",
      "discord sync verified at of %player%"
    );
  }
}
