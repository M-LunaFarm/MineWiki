package kr.lunaf.verify;

public class DiscordSyncEntry {
  private final String mcUuid;
  private final String mcIgn;
  private final String discordUserId;
  private final String guildId;
  private final String occurredAt;
  private final String verifiedAt;

  public DiscordSyncEntry(
    String mcUuid,
    String mcIgn,
    String discordUserId,
    String guildId,
    String occurredAt,
    String verifiedAt
  ) {
    this.mcUuid = mcUuid;
    this.mcIgn = mcIgn;
    this.discordUserId = discordUserId;
    this.guildId = guildId;
    this.occurredAt = occurredAt;
    this.verifiedAt = verifiedAt;
  }

  public String getMcUuid() {
    return mcUuid;
  }

  public String getMcIgn() {
    return mcIgn;
  }

  public String getDiscordUserId() {
    return discordUserId;
  }

  public String getGuildId() {
    return guildId;
  }

  public String getOccurredAt() {
    return occurredAt;
  }

  public String getVerifiedAt() {
    return verifiedAt;
  }
}
