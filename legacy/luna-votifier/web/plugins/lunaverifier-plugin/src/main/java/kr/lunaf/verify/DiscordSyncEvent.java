package kr.lunaf.verify;

import org.bukkit.entity.Player;
import org.bukkit.event.Event;
import org.bukkit.event.HandlerList;

public class DiscordSyncEvent extends Event {
  private static final HandlerList HANDLERS = new HandlerList();
  private final DiscordSyncAction action;
  private final DiscordSyncEntry entry;
  private final Player player;

  public DiscordSyncEvent(DiscordSyncAction action, DiscordSyncEntry entry, Player player) {
    super();
    this.action = action;
    this.entry = entry;
    this.player = player;
  }

  public DiscordSyncAction getAction() {
    return action;
  }

  public DiscordSyncEntry getEntry() {
    return entry;
  }

  public Player getPlayer() {
    return player;
  }

  @Override
  public HandlerList getHandlers() {
    return HANDLERS;
  }

  public static HandlerList getHandlerList() {
    return HANDLERS;
  }
}
