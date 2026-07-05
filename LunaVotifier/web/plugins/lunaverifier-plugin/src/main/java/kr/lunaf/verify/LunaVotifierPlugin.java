package kr.lunaf.verify;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

public class LunaVotifierPlugin extends JavaPlugin {
  private static final String HMAC_ALGO = "HmacSHA256";
  private static final String CACHE_FILE = "processed-events.json";
  private static LunaVotifierPlugin instance;

  private final Gson gson = new Gson();
  private TcpServer tcpServer;
  private EventDeduplicator deduplicator;
  private ActionExecutor actionExecutor;
  private UpdateService updateService;
  private DiscordSyncService discordSyncService;
  private String serverSecret;
  private boolean requireSignature;
  private long timestampSkewSeconds;
  private final ConcurrentMap<String, DiscordSyncEntry> discordSyncCache = new ConcurrentHashMap<>();

  @Override
  public void onEnable() {
    instance = this;
    saveDefaultConfig();
    reloadConfig();

    final int port = getConfig().getInt("listen-port", 8192);
    final String configuredSecret = getConfig().getString("server-secret", "");
    serverSecret = configuredSecret == null ? "" : configuredSecret.trim();
    final boolean configRequireSignature = getConfig().getBoolean("require-signature", true);
    requireSignature = true;
    timestampSkewSeconds = getConfig().getLong("timestamp-skew-seconds", 300L);

    if (!configRequireSignature) {
      getLogger().warning("require-signature is false in config; overriding to true for safety.");
    }
    if (serverSecret.isEmpty()) {
      getLogger().severe("server-secret is empty. Signature verification is required; disabling plugin.");
      getServer().getPluginManager().disablePlugin(this);
      return;
    }

    final long ttlSeconds = getConfig().getLong("idempotency-ttl-seconds", 86400L);
    deduplicator = new EventDeduplicator(new File(getDataFolder(), CACHE_FILE), ttlSeconds);
    deduplicator.load();

    actionExecutor = new ActionExecutor(this, getConfig());

    final int tcpWorkerThreads = Math.max(1, getConfig().getInt("tcp-worker-threads", 8));
    final int tcpWorkerQueue = Math.max(1, getConfig().getInt("tcp-worker-queue-size", 100));
    tcpServer = new TcpServer(
      this,
      port,
      tcpWorkerThreads,
      tcpWorkerQueue
    );
    try {
      tcpServer.start();
      getLogger().info("Listening for LunaVotifier events on port " + port);
    } catch (Exception err) {
      getLogger().severe("Failed to start TCP listener: " + err.getMessage());
    }

    updateService = new UpdateService(this, getConfig());
    updateService.start();

    discordSyncService = new DiscordSyncService(this, getConfig());
    discordSyncService.start();

    tryEnableSkriptAddon();
  }

  @Override
  public void onDisable() {
    instance = null;
    if (tcpServer != null) {
      tcpServer.close();
      tcpServer = null;
    }
    if (deduplicator != null) {
      deduplicator.save();
    }
    if (actionExecutor != null) {
      actionExecutor.shutdown();
    }
    if (updateService != null) {
      updateService.stop();
    }
    if (discordSyncService != null) {
      discordSyncService.stop();
    }
  }

  public static LunaVotifierPlugin getInstance() {
    return instance;
  }

  public String handlePacket(String rawLine) {
    if (rawLine == null || rawLine.trim().isEmpty()) {
      return "error: empty";
    }

    final JsonObject packet;
    try {
      packet = JsonParser.parseString(rawLine).getAsJsonObject();
    } catch (Exception err) {
      return "error: invalid_json";
    }

    final String timestamp = getString(packet, "timestamp");
    final String nonce = getString(packet, "nonce");
    final String signature = getString(packet, "signature");
    final JsonElement payloadElement = packet.get("payload");

    if (timestamp == null || nonce == null || payloadElement == null) {
      return "error: missing_fields";
    }

    if (requireSignature) {
      final String expected = computeSignature(timestamp, nonce, payloadElement);
      if (!secureEquals(expected, signature)) {
        return "error: bad_signature";
      }
    }

    if (timestampSkewSeconds > 0) {
      final long now = Instant.now().getEpochSecond();
      final long ts;
      try {
        ts = Long.parseLong(timestamp);
      } catch (NumberFormatException err) {
        return "error: bad_timestamp";
      }
      if (Math.abs(now - ts) > timestampSkewSeconds) {
        return "error: stale";
      }
    }

    if (!payloadElement.isJsonObject()) {
      return "error: invalid_payload";
    }

    final JsonObject payload = payloadElement.getAsJsonObject();
    final String eventId = getString(payload, "event_id");
    if (eventId == null || eventId.isEmpty()) {
      return "error: missing_event_id";
    }

    if (!deduplicator.markIfNew(eventId)) {
      return "ok";
    }

    final String eventType = getString(payload, "event_type");
    final TokenReplacer tokens = buildTokens(payload);

    handleDiscordSyncEvent(eventType, payload);

    JsonArray actions = new JsonArray();
    if (payload.has("actions") && payload.get("actions").isJsonArray()) {
      actions = payload.getAsJsonArray("actions");
    }

    actionExecutor.execute(actions, tokens, eventType == null ? "unknown" : eventType);

    return "ok";
  }

  private String computeSignature(String timestamp, String nonce, JsonElement payloadElement) {
    final String body = "{\"timestamp\":" + gson.toJson(timestamp)
      + ",\"nonce\":" + gson.toJson(nonce)
      + ",\"payload\":" + payloadElement.toString()
      + "}";
    return hmacSha256Hex(serverSecret, body);
  }

  private TokenReplacer buildTokens(JsonObject payload) {
    final Map<String, String> tokens = new HashMap<>();
    tokens.put("player", getString(payload, "mc_ign"));
    tokens.put("ign", getString(payload, "mc_ign"));
    tokens.put("uuid", getString(payload, "mc_uuid"));
    tokens.put("discord_id", getString(payload, "discord_user_id"));
    tokens.put("guild_id", getString(payload, "guild_id"));
    tokens.put("channel_id", getString(payload, "channel_id"));
    tokens.put("event_type", getString(payload, "event_type"));
    tokens.put("event_id", getString(payload, "event_id"));
    tokens.put("occurred_at", getString(payload, "occurred_at"));
    return new TokenReplacer(tokens);
  }

  private static String getString(JsonObject obj, String key) {
    if (obj == null || key == null || !obj.has(key) || obj.get(key).isJsonNull()) {
      return null;
    }
    try {
      return obj.get(key).getAsString();
    } catch (Exception err) {
      return null;
    }
  }

  private static String hmacSha256Hex(String secret, String input) {
    if (secret == null) {
      return "";
    }
    try {
      final Mac mac = Mac.getInstance(HMAC_ALGO);
      mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), HMAC_ALGO));
      final byte[] digest = mac.doFinal(input.getBytes(StandardCharsets.UTF_8));
      return bytesToHex(digest);
    } catch (Exception err) {
      return "";
    }
  }

  private static String bytesToHex(byte[] data) {
    final StringBuilder sb = new StringBuilder(data.length * 2);
    for (byte b : data) {
      sb.append(String.format("%02x", b));
    }
    return sb.toString();
  }

  private static boolean secureEquals(String expected, String actual) {
    if (expected == null || actual == null) {
      return false;
    }
    if (expected.length() != actual.length()) {
      return false;
    }
    final byte[] a = expected.getBytes(StandardCharsets.UTF_8);
    final byte[] b = actual.getBytes(StandardCharsets.UTF_8);
    return MessageDigest.isEqual(a, b);
  }

  public void runOnMainThread(Runnable task) {
    if (Bukkit.isPrimaryThread()) {
      task.run();
      return;
    }
    Bukkit.getScheduler().runTask(this, task);
  }

  public boolean isDiscordSync(Player player) {
    if (player == null) {
      return false;
    }
    return discordSyncCache.containsKey(player.getUniqueId().toString());
  }

  public DiscordSyncEntry getDiscordSyncEntry(Player player) {
    if (player == null) {
      return null;
    }
    return discordSyncCache.get(player.getUniqueId().toString());
  }

  public java.util.List<DiscordSyncEntry> getDiscordSyncList() {
    return Collections.unmodifiableList(new ArrayList<>(discordSyncCache.values()));
  }

  public void applySyncSnapshot(java.util.List<DiscordSyncEntry> entries, boolean fireEvents) {
    if (entries == null) {
      return;
    }
    final Map<String, DiscordSyncEntry> next = new HashMap<>();
    for (DiscordSyncEntry entry : entries) {
      if (entry == null) {
        continue;
      }
      final String normalizedUuid = normalizeUuid(entry.getMcUuid());
      if (normalizedUuid == null) {
        continue;
      }
      next.put(normalizedUuid, entry);
    }

    for (Map.Entry<String, DiscordSyncEntry> existing : new HashMap<>(discordSyncCache).entrySet()) {
      if (!next.containsKey(existing.getKey())) {
        discordSyncCache.remove(existing.getKey());
        if (fireEvents && existing.getValue() != null) {
          dispatchDiscordSyncEvent(DiscordSyncAction.REVOKED, existing.getValue());
        }
      }
    }

    for (Map.Entry<String, DiscordSyncEntry> incoming : next.entrySet()) {
      final DiscordSyncEntry existing = discordSyncCache.get(incoming.getKey());
      if (existing == null) {
        discordSyncCache.put(incoming.getKey(), incoming.getValue());
        if (fireEvents) {
          dispatchDiscordSyncEvent(DiscordSyncAction.SYNCED, incoming.getValue());
        }
      } else if (isEntryDifferent(existing, incoming.getValue())) {
        discordSyncCache.put(incoming.getKey(), incoming.getValue());
        if (fireEvents) {
          dispatchDiscordSyncEvent(DiscordSyncAction.REVERIFIED, incoming.getValue());
        }
      }
    }
  }

  private void handleDiscordSyncEvent(String eventType, JsonObject payload) {
    if (eventType == null || payload == null) {
      return;
    }

    final DiscordSyncAction action = mapDiscordSyncAction(eventType);
    if (action == null) {
      return;
    }

    final String normalizedUuid = normalizeUuid(getString(payload, "mc_uuid"));
    if (normalizedUuid == null) {
      return;
    }

    final DiscordSyncEntry entry = new DiscordSyncEntry(
      normalizedUuid,
      getString(payload, "mc_ign"),
      getString(payload, "discord_user_id"),
      getString(payload, "guild_id"),
      getString(payload, "occurred_at"),
      null
    );

    if (action == DiscordSyncAction.REVOKED) {
      discordSyncCache.remove(normalizedUuid);
    } else {
      discordSyncCache.put(normalizedUuid, entry);
    }

    dispatchDiscordSyncEvent(action, entry);
  }

  private DiscordSyncAction mapDiscordSyncAction(String eventType) {
    if ("verification.completed".equalsIgnoreCase(eventType)) {
      return DiscordSyncAction.SYNCED;
    }
    if ("verification.revoked".equalsIgnoreCase(eventType)) {
      return DiscordSyncAction.REVOKED;
    }
    if ("verification.reverified".equalsIgnoreCase(eventType)) {
      return DiscordSyncAction.REVERIFIED;
    }
    return null;
  }

  private String normalizeUuid(String rawUuid) {
    if (rawUuid == null || rawUuid.isBlank()) {
      return null;
    }
    try {
      return UUID.fromString(rawUuid.trim()).toString();
    } catch (IllegalArgumentException err) {
      return null;
    }
  }

  private Player findPlayerByUuid(String uuid) {
    if (uuid == null || uuid.isBlank()) {
      return null;
    }
    try {
      return Bukkit.getPlayer(UUID.fromString(uuid));
    } catch (IllegalArgumentException err) {
      return null;
    }
  }

  private void dispatchDiscordSyncEvent(DiscordSyncAction action, DiscordSyncEntry entry) {
    if (action == null || entry == null) {
      return;
    }
    final String normalizedUuid = normalizeUuid(entry.getMcUuid());
    final Player player = findPlayerByUuid(normalizedUuid);
    runOnMainThread(() -> Bukkit.getPluginManager().callEvent(new DiscordSyncEvent(action, entry, player)));
  }

  private boolean isEntryDifferent(DiscordSyncEntry a, DiscordSyncEntry b) {
    if (a == null || b == null) {
      return true;
    }
    return !safeEquals(a.getDiscordUserId(), b.getDiscordUserId())
      || !safeEquals(a.getMcIgn(), b.getMcIgn())
      || !safeEquals(a.getGuildId(), b.getGuildId());
  }

  private boolean safeEquals(String a, String b) {
    if (a == null && b == null) {
      return true;
    }
    if (a == null || b == null) {
      return false;
    }
    return a.equals(b);
  }

  private void tryEnableSkriptAddon() {
    try {
      if (getServer().getPluginManager().getPlugin("Skript") == null) {
        return;
      }
      Class<?> hookClass = Class.forName("kr.lunaf.verify.skript.SkriptAddonBootstrap");
      hookClass.getMethod("register", LunaVotifierPlugin.class).invoke(null, this);
      getLogger().info("Skript addon enabled.");
    } catch (ClassNotFoundException err) {
      // Skript addon classes not found.
    } catch (Exception err) {
      getLogger().warning("Failed to enable Skript addon: " + err.getMessage());
    }
  }
}
