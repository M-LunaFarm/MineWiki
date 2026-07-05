package kr.lunaf.verify;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.File;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.bukkit.Bukkit;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.plugin.java.JavaPlugin;

public class DiscordSyncService {
  private static final String HMAC_ALGO = "HmacSHA256";
  private static final String DEFAULT_SYNC_API_URL = "https://verify.lunaf.kr/api/v1/plugin/sync-9b4f7d2c6a5e4f3aa1d8b9a7c6e5d4f3";
  private final JavaPlugin plugin;
  private final Gson gson = new Gson();
  private final HttpClient client;
  private final boolean enabled;
  private final boolean syncOnStartup;
  private final boolean fireInitialEvents;
  private final boolean fireEvents;
  private final String apiUrl;
  private final String serverId;
  private final String serverSecret;
  private final long intervalTicks;
  private final int timeoutSeconds;
  private final long cooldownSeconds;
  private final Path stateFile;
  private volatile long lastSyncEpochSeconds = 0L;
  private int taskId = -1;
  private boolean initialSyncDone = false;

  public DiscordSyncService(JavaPlugin plugin, FileConfiguration config) {
    this.plugin = plugin;
    this.enabled = config.getBoolean("sync-enabled", false);
    this.syncOnStartup = config.getBoolean("sync-on-startup", true);
    this.fireInitialEvents = config.getBoolean("sync-fire-initial-events", false);
    this.fireEvents = config.getBoolean("sync-fire-events", true);
    final String configuredUrl = String.valueOf(config.getString("sync-api-url", "")).trim();
    this.apiUrl = configuredUrl.isEmpty() ? DEFAULT_SYNC_API_URL : configuredUrl;
    this.serverId = String.valueOf(config.getString("sync-server-id", "")).trim();
    this.serverSecret = String.valueOf(config.getString("server-secret", "")).trim();
    final long intervalSeconds = Math.max(0L, config.getLong("sync-interval-seconds", 300L));
    this.intervalTicks = intervalSeconds * 20L;
    this.timeoutSeconds = Math.max(3, config.getInt("sync-timeout-seconds", 6));
    this.cooldownSeconds = Math.max(0L, config.getLong("sync-cooldown-seconds", 60L));
    this.stateFile = new File(plugin.getDataFolder(), "sync-state.txt").toPath();
    this.client = HttpClient.newBuilder()
      .connectTimeout(Duration.ofSeconds(3))
      .build();
    loadLastSync();
  }

  public void start() {
    if (!enabled) {
      return;
    }
    if (apiUrl.isEmpty() || serverId.isEmpty() || serverSecret.isEmpty()) {
      plugin.getLogger().warning("Sync disabled: sync-api-url/server-id/server-secret not set.");
      return;
    }

    if (syncOnStartup) {
      if (canSyncNow()) {
        Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> syncOnce(true));
      } else if (intervalTicks <= 0L) {
        final long delaySeconds = Math.max(1L, cooldownSeconds - (nowEpochSeconds() - lastSyncEpochSeconds));
        Bukkit.getScheduler().runTaskLaterAsynchronously(plugin, () -> syncOnce(true), delaySeconds * 20L);
      }
    }

    if (intervalTicks > 0L) {
      taskId = Bukkit.getScheduler().runTaskTimerAsynchronously(
        plugin,
        () -> syncOnce(false),
        intervalTicks,
        intervalTicks
      ).getTaskId();
    }
  }

  public void stop() {
    if (taskId != -1) {
      Bukkit.getScheduler().cancelTask(taskId);
      taskId = -1;
    }
  }

  private void syncOnce(boolean isInitialRun) {
    if (!canSyncNow()) {
      return;
    }
    try {
      final String timestamp = String.valueOf(System.currentTimeMillis() / 1000);
      final String nonce = java.util.UUID.randomUUID().toString();
      final JsonObject payload = new JsonObject();
      payload.addProperty("server_id", serverId);

      final String signatureBody = buildSignatureBody(timestamp, nonce, payload);
      final String signature = hmacSha256Hex(serverSecret, signatureBody);

      final JsonObject requestBody = new JsonObject();
      requestBody.addProperty("timestamp", timestamp);
      requestBody.addProperty("nonce", nonce);
      requestBody.add("payload", payload);
      requestBody.addProperty("signature", signature);

      final HttpRequest request = HttpRequest.newBuilder()
        .uri(URI.create(apiUrl))
        .timeout(Duration.ofSeconds(timeoutSeconds))
        .header("Content-Type", "application/json")
        .header("User-Agent", "LunaVerifier/" + plugin.getDescription().getVersion())
        .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(requestBody), StandardCharsets.UTF_8))
        .build();

      final HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
      if (response.statusCode() == 429) {
        plugin.getLogger().info("Sync rate limited by server.");
        return;
      }
      if (response.statusCode() != 200) {
        plugin.getLogger().warning("Sync failed: HTTP " + response.statusCode());
        return;
      }

      final JsonObject root = JsonParser.parseString(response.body()).getAsJsonObject();
      final JsonArray entries = root.has("entries") && root.get("entries").isJsonArray()
        ? root.getAsJsonArray("entries")
        : new JsonArray();

      final List<DiscordSyncEntry> snapshot = new ArrayList<>();
      for (JsonElement element : entries) {
        if (!element.isJsonObject()) {
          continue;
        }
        final JsonObject obj = element.getAsJsonObject();
        final String mcUuid = getString(obj, "mc_uuid");
        if (mcUuid == null || mcUuid.isBlank()) {
          continue;
        }
        final String occurredAt = getString(obj, "occurred_at");
        final String verifiedAt = getString(obj, "verified_at");
        snapshot.add(new DiscordSyncEntry(
          mcUuid,
          getString(obj, "mc_ign"),
          getString(obj, "discord_user_id"),
          getString(obj, "guild_id"),
          occurredAt,
          verifiedAt
        ));
      }

      final boolean shouldFireEvents = fireEvents && (!isInitialRun || fireInitialEvents || initialSyncDone);
      if (plugin instanceof LunaVotifierPlugin) {
        ((LunaVotifierPlugin) plugin).applySyncSnapshot(snapshot, shouldFireEvents);
      }
      lastSyncEpochSeconds = nowEpochSeconds();
      saveLastSync();
      initialSyncDone = true;
    } catch (Exception err) {
      plugin.getLogger().warning("Sync error: " + err.getMessage());
    }
  }

  private String buildSignatureBody(String timestamp, String nonce, JsonObject payload) {
    return "{\"timestamp\":" + gson.toJson(timestamp)
      + ",\"nonce\":" + gson.toJson(nonce)
      + ",\"payload\":" + payload.toString()
      + "}";
  }

  private static String hmacSha256Hex(String secret, String input) {
    if (secret == null) {
      return "";
    }
    try {
      final Mac mac = Mac.getInstance(HMAC_ALGO);
      mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), HMAC_ALGO));
      final byte[] digest = mac.doFinal(input.getBytes(StandardCharsets.UTF_8));
      final StringBuilder sb = new StringBuilder(digest.length * 2);
      for (byte b : digest) {
        sb.append(String.format("%02x", b));
      }
      return sb.toString();
    } catch (Exception err) {
      return "";
    }
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

  private boolean canSyncNow() {
    if (cooldownSeconds <= 0L) {
      return true;
    }
    final long now = nowEpochSeconds();
    return now - lastSyncEpochSeconds >= cooldownSeconds;
  }

  private long nowEpochSeconds() {
    return System.currentTimeMillis() / 1000;
  }

  private void loadLastSync() {
    try {
      if (!Files.exists(stateFile)) {
        return;
      }
      final String text = Files.readString(stateFile, StandardCharsets.UTF_8).trim();
      if (!text.isEmpty()) {
        lastSyncEpochSeconds = Long.parseLong(text);
      }
    } catch (Exception err) {
      // ignore invalid state
    }
  }

  private void saveLastSync() {
    try {
      Files.createDirectories(stateFile.getParent());
      Files.writeString(stateFile, String.valueOf(lastSyncEpochSeconds), StandardCharsets.UTF_8);
    } catch (Exception err) {
      // ignore
    }
  }
}
